#!/usr/bin/env python3
"""Textual dashboard wrapper for the ATF Node automation worker."""

from __future__ import annotations

import argparse
import asyncio
import codecs
import json
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from rich.markup import escape
    from rich.text import Text
    from textual import events
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Horizontal, Vertical
    from textual.widgets import DataTable, Footer, RichLog, Static
except ImportError:
    print("Dependency Textual belum ada.")
    print("Install dengan: python -m pip install -r requirements-textual.txt")
    raise SystemExit(1)


ROOT = Path(__file__).resolve().parent
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
ACCOUNT_RE = re.compile(r"\[AKUN\s+(\d+)/(\d+)\]\s+(.+?)\s+\(([^()]+\.session)\)", re.I)
ACCOUNT_CONTEXT_RE = re.compile(r"\[ACCOUNT:([^\]\r\n]+\.session)\]", re.I)
BALANCE_RE = re.compile(r"Level\s+(\d+)\s+\|\s+Mined\s+([\d.,-]+)\s+ATF\s+\|\s+Pending(?:\s+Reward)?\s+([\d.,-]+)\s+ATF", re.I)
TASK_RE = re.compile(r"Ringkasan task:\s+(\d+) started,\s+(\d+) claimed,\s+(\d+) reported,\s+(\d+) failed", re.I)
REFERRAL_STATS_RE = re.compile(r"Referral stats:\s+(\d+) success\s*/\s*(\d+) total", re.I)
NEXT_TASK_RE = re.compile(r"Next claim task:\s+\d+\s+menit\s+\(epoch\s+(\d+)\)", re.I)
PROFILE_RE = re.compile(r"Dashboard profile:\s+@([A-Za-z0-9_]{1,64})\s+\|\s+ATF Holding\s+([\d.,-]+)\s+ATF", re.I)
CYCLE_RE = re.compile(r"(?:Siklus|Pass utama) selesai:\s+(\d+) sukses,\s+(\d+) parsial(?:/worker)?,\s+(\d+) gagal", re.I)
COUNTDOWN_RE = re.compile(r"Siklus berikutnya:\s*(.+)$", re.I)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ATF Textual terminal dashboard")
    parser.add_argument("--worker", type=Path, default=ROOT / "index.js")
    parser.add_argument("--node", default="node")
    return parser.parse_args()


def number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(str(value).replace(",", ""))
        return parsed if parsed == parsed else default
    except (TypeError, ValueError):
        return default


def compact(value: Any, decimals: int = 4) -> str:
    parsed = number(value)
    text = f"{parsed:,.{decimals}f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def clean_line(raw: str) -> str:
    return ANSI_RE.sub("", raw).replace("\x00", "").strip()


def severity(line: str) -> str:
    upper = line.upper()
    if "[ERROR]" in upper or "FATAL" in upper:
        return "error"
    if "[WARN]" in upper or "GAGAL" in upper:
        return "warn"
    if "[SUCCESS]" in upper or "BERHASIL" in upper:
        return "success"
    if "[DEBUG]" in upper:
        return "debug"
    return "info"


def default_account(label: str, file_name: str) -> dict[str, Any]:
    return {
        "label": label,
        "file": file_name,
        "status": "waiting",
        "level": "-",
        "mined": 0.0,
        "atf_holding": 0.0,
        "pending": 0.0,
        "wallet": "-",
        "mining": "-",
        "task_started": 0,
        "task_claimed": 0,
        "task_failed": 0,
        "next_task_at": 0,
        "ref_success": 0,
        "ref_total": 0,
        "referral": "-",
        "team_wallet": "-",
        "connection": "-",
    }


def discover_accounts() -> list[dict[str, Any]]:
    config: dict[str, Any] = {}
    config_path = ROOT / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    telegram = config.get("telegram") or {}
    session_directory = ROOT / str(telegram.get("session_directory") or "session")
    override_name = str(telegram.get("account_overrides_file") or "account-overrides.json")
    overrides: dict[str, Any] = {}
    try:
        parsed = json.loads((ROOT / override_name).read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            overrides = parsed
    except (OSError, json.JSONDecodeError):
        pass

    if not session_directory.is_dir():
        return []
    result = []
    for session_path in sorted(session_directory.glob("*.session"), key=lambda item: item.name.lower()):
        override = overrides.get(session_path.name) or {}
        if isinstance(override, dict) and override.get("enabled") is False:
            continue
        result.append(default_account(session_path.stem, session_path.name))
    return result


def status_cell(account: dict[str, Any]) -> Text:
    status = str(account.get("status") or "waiting").lower()
    if status == "success":
        return Text("● Selesai", style="bold #78dba9")
    if status == "partial":
        return Text("● Parsial", style="bold #ffc857")
    if status == "deferred":
        return Text("● Retry nanti", style="bold #ffc857")
    if status == "worker":
        return Text("● Worker", style="bold #5fd7ff")
    if status == "fetching":
        return Text("● Fetching", style="bold #ffb38a")
    if status in {"failed", "fatal"}:
        return Text("● Gagal", style="bold #ff6b88")
    if status in {"running", "auth", "login"}:
        return Text("● Proses", style="bold #b6a0ff")
    return Text("● Menunggu", style="#9a94b8")


class AccountTable(DataTable):
    BINDINGS = [
        Binding("q", "quit_dashboard", "Stop & Keluar", priority=True),
        Binding("p", "toggle_pause", "Pause/Resume", priority=True),
        Binding("r", "refresh_stats", "Refresh stats", priority=True),
        Binding("c", "clear_logs", "Clear log", priority=True),
        Binding("pageup", "log_page_up", "Log PgUp", priority=True),
        Binding("pagedown", "log_page_down", "Log PgDn", priority=True),
        Binding("g", "log_home", "Log awal", priority=True),
        Binding("shift+g", "log_end", "Log akhir", priority=True),
    ]

    async def action_quit_dashboard(self) -> None:
        await self.app.action_quit_dashboard()

    def action_toggle_pause(self) -> None:
        self.app.action_toggle_pause()

    def action_refresh_stats(self) -> None:
        self.app.action_refresh_stats()

    def action_clear_logs(self) -> None:
        self.app.action_clear_logs()

    def action_log_page_up(self) -> None:
        self.app.action_log_page_up()

    def action_log_page_down(self) -> None:
        self.app.action_log_page_down()

    def action_log_home(self) -> None:
        self.app.action_log_home()

    def action_log_end(self) -> None:
        self.app.action_log_end()


class ATFDashboard(App[None]):
    TITLE = "ATF Miner Tools Dashboard"
    CSS = """
    Screen { background: #090817; color: #ece9ff; }
    #title_bar { height: 2; background: #1a1430; border-bottom: solid #ff7a90; }
    #title_spacer { width: 25; }
    #app_title { width: 1fr; content-align: center middle; text-style: bold; color: #c7b8ff; }
    #clock { width: 25; content-align: right middle; padding-right: 1; color: #ffb38a; }
    #global_summary { height: 2; margin: 0 1; padding: 0 2; content-align: left middle; background: #120f24; color: #ffc857; text-style: bold; }
    #main_container { height: 1fr; }
    #accounts_table { height: 46%; margin: 1 1 0 1; padding: 0 1; border: round #8d79d6; background: #0d0b1b; }
    #accounts_table > .datatable--header { background: #39285f; color: #fff4df; text-style: bold; }
    #accounts_table > .datatable--cursor { background: #5a3f78; color: #ffffff; }
    #bottom_panel { height: 1fr; margin: 1; }
    #log_panel { width: 2fr; height: 100%; margin-right: 1; padding: 0 1; border: round #ff8066; background: #0d0b1b; }
    #summary_box { width: 1fr; height: 100%; border: round #e6b84a; background: #100d20; padding: 1 2; }
    Footer { height: 1; background: #1a1430; color: #e8dcff; }
    """
    BINDINGS = [
        Binding("q", "quit_dashboard", "Stop & Keluar", priority=True),
        Binding("p", "toggle_pause", "Pause/Resume", priority=True),
        Binding("r", "refresh_stats", "Refresh stats", priority=True),
        Binding("c", "clear_logs", "Clear log", priority=True),
        Binding("pageup", "log_page_up", "Log PgUp", priority=True),
        Binding("pagedown", "log_page_down", "Log PgDn", priority=True),
        Binding("g", "log_home", "Log awal", priority=True),
        Binding("shift+g", "log_end", "Log akhir", priority=True),
    ]

    def __init__(self, options: argparse.Namespace) -> None:
        super().__init__()
        self.options = options
        self.worker: subprocess.Popen[bytes] | None = None
        self.accounts: dict[str, dict[str, Any]] = {
            account["file"]: account for account in discover_accounts()
        }
        self.current_key = ""
        self.current_index = 0
        self.total_accounts = len(self.accounts)
        self.cycle_number = 1
        self.cycle_result = {"success": 0, "partial": 0, "failed": 0}
        self.next_cycle = "-"
        self.started_at = time.monotonic()
        self.paused = False
        self._dirty = True
        self._closing = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="title_bar"):
            yield Static("", id="title_spacer")
            yield Static("ATF MINER TOOLS DASHBOARD", id="app_title")
            yield Static("", id="clock")
        yield Static("Menyiapkan worker Node…", id="global_summary", markup=True)
        with Vertical(id="main_container"):
            yield AccountTable(id="accounts_table", zebra_stripes=True)
            with Horizontal(id="bottom_panel"):
                # Gunakan RichLog bawaan seperti dashboard Silvana. Scroll mouse
                # ditangani langsung oleh ScrollView/Textual saat pointer berada
                # di panel log.
                yield RichLog(id="log_panel", markup=False, wrap=True, auto_scroll=False)
                yield Static("[bold #c7b8ff]ATF Summary[/bold #c7b8ff]\n\nLoading…", id="summary_box", markup=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#accounts_table", DataTable)
        table.cursor_type = "row"
        for label, width in (
            ("TELEGRAM USERNAME", 18), ("STATUS", 13), ("LEVEL", 7), ("MINED ATF", 12),
            ("ATF HOLDING", 16), ("PENDING REWARD", 16), ("WALLET", 15), ("MINING", 15), ("TASK CLAIM", 12),
            ("NEXT CLAIM TASK", 17), ("REF SUCCESS", 13), ("TOTAL REF", 11),
            ("REF CLAIM", 13), ("TEAM WALLET", 14), ("KONEKSI", 18),
        ):
            table.add_column(label, width=width)
        table.focus()
        self.set_interval(0.25, self._refresh_if_dirty)
        self.set_interval(1.0, self._tick)
        self._refresh_if_dirty()
        self._tick()
        self._start_worker()

    def on_resize(self, _event: events.Resize) -> None:
        self._dirty = True

    def _start_worker(self) -> None:
        worker_path = self.options.worker.resolve()
        if not worker_path.is_file():
            self._write_log(f"Worker tidak ditemukan: {worker_path}", "error")
            return
        if self.worker is not None and self.worker.poll() is None:
            return

        environment = os.environ.copy()
        environment["NO_COLOR"] = "1"
        environment["FORCE_COLOR"] = "0"
        environment["ATF_TEXTUAL_WORKER"] = "1"
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
        try:
            self.worker = subprocess.Popen(
                [self.options.node, str(worker_path), "--run"],
                cwd=worker_path.parent,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                creationflags=creation_flags,
            )
        except Exception as error:
            self.worker = None
            self._write_log(f"Gagal menjalankan worker Node: {error}", "error")
            return

        self._write_log(f"Worker Node aktif · PID {self.worker.pid}", "success")
        threading.Thread(target=self._read_worker_output, args=(self.worker,), daemon=True).start()
        self._dirty = True

    def _read_worker_output(self, worker: subprocess.Popen[bytes]) -> None:
        if worker.stdout is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        try:
            while True:
                chunk = os.read(worker.stdout.fileno(), 4096)
                if not chunk:
                    break
                pending += decoder.decode(chunk)
                parts = re.split(r"[\r\n]+", pending)
                pending = parts.pop()
                for part in parts:
                    if part.strip():
                        self.call_from_thread(self._consume_line, part)
            pending += decoder.decode(b"", final=True)
            if pending.strip():
                self.call_from_thread(self._consume_line, pending)
        except (OSError, ValueError) as error:
            if not self._closing:
                self.call_from_thread(self._write_log, f"Pembaca log berhenti: {error}", "error")
        finally:
            code = worker.wait()
            self.call_from_thread(self._worker_stopped, worker, code)

    def _account(self) -> dict[str, Any] | None:
        return self.accounts.get(self.current_key)

    def _consume_dashboard_event(self, line: str) -> bool:
        marker = "[DASHBOARD_EVENT]"
        marker_at = line.find(marker)
        if marker_at < 0:
            return False
        raw_payload = line[marker_at + len(marker):].strip()
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            self._write_log("Dashboard event tidak valid dan diabaikan", "warn")
            return True
        if not isinstance(payload, dict):
            return True

        account_key = str(payload.get("account") or "").strip()
        if not account_key or Path(account_key).name != account_key or not account_key.lower().endswith(".session"):
            return True
        account = self.accounts.setdefault(
            account_key,
            default_account(Path(account_key).stem, account_key),
        )

        text_fields = {
            "label", "status", "level", "wallet", "mining", "referral",
            "team_wallet", "connection",
        }
        number_fields = {"mined", "atf_holding", "pending", "next_task_at"}
        integer_fields = {"task_started", "task_claimed", "task_failed", "ref_success", "ref_total"}
        for key in text_fields:
            if key in payload:
                account[key] = str(payload[key])
        for key in number_fields:
            if key in payload:
                account[key] = number(payload[key])
        for key in integer_fields:
            if key in payload:
                account[key] = max(0, int(number(payload[key])))

        self._dirty = True
        return True

    def _consume_line(self, raw: str) -> None:
        line = clean_line(raw)
        if not line:
            return

        if self._consume_dashboard_event(line):
            return

        countdown_match = COUNTDOWN_RE.search(line)
        if countdown_match:
            self.next_cycle = countdown_match.group(1).strip()
            self._dirty = True
            return

        account_match = ACCOUNT_RE.search(line)
        if account_match:
            self.current_index = int(account_match.group(1))
            self.total_accounts = int(account_match.group(2))
            label = account_match.group(3).strip()
            file_name = account_match.group(4).strip()
            self.current_key = file_name
            account = self.accounts.setdefault(file_name, default_account(label, file_name))
            account["label"] = label
            account["status"] = "running"
            self._dirty = True
            self._write_log(line, "info")
            return

        context_match = ACCOUNT_CONTEXT_RE.search(line)
        if context_match:
            context_key = context_match.group(1).strip()
            account = self.accounts.setdefault(
                context_key,
                default_account(Path(context_key).stem, context_key),
            )
        else:
            account = self._account()
        level = severity(line)

        if "Memulai " in line and " akun session" in line:
            match = re.search(r"Memulai\s+(\d+)\s+akun", line, re.I)
            if match:
                self.total_accounts = int(match.group(1))
            self.current_index = 0
            self.next_cycle = "-"
            for item in self.accounts.values():
                item["status"] = "waiting"
                item["task_started"] = 0
                item["task_claimed"] = 0
                item["task_failed"] = 0

        if "Dashboard pause: aktif" in line:
            self.paused = True
        elif "Dashboard pause: nonaktif" in line:
            self.paused = False

        if account is not None:
            if "ATF API:" in line:
                match = re.search(r"ATF API:\s*(.+?)\.\s*Telegram session", line, re.I)
                if match:
                    account["connection"] = match.group(1).strip()
            elif "Telegram auth aktif:" in line:
                account["status"] = "auth"
            elif "Telegram session gagal:" in line or "Login ATF gagal:" in line:
                account["status"] = "failed"

            balance_match = BALANCE_RE.search(line)
            if balance_match:
                account["level"] = balance_match.group(1)
                account["mined"] = number(balance_match.group(2))
                account["pending"] = number(balance_match.group(3))
                account["status"] = "running"

            profile_match = PROFILE_RE.search(line)
            if profile_match:
                account["label"] = f"@{profile_match.group(1)}"
                account["atf_holding"] = number(profile_match.group(2))
            elif "Telegram auth aktif:" in line:
                auth_profile = re.search(r"Telegram auth aktif:\s*(.+?)\s+\(@([^|)]+)\s*\|", line, re.I)
                if auth_profile:
                    telegram_username = auth_profile.group(2).strip()
                    account["label"] = f"@{telegram_username}" if telegram_username != "-" else auth_profile.group(1).strip()

            if "Wallet TON sudah terverifikasi" in line or "Wallet TON berhasil dikoneksikan" in line:
                account["wallet"] = "Connected"
            elif "Wallet TON baru dibuat" in line:
                account["wallet"] = "Created"
            elif "Wallet sync masih busy" in line:
                retry = re.search(r"retry\s+(\d+)", line, re.I)
                account["wallet"] = f"Retry {retry.group(1)}" if retry else "Retry 60s"
            elif "akun ditunda sampai semua akun utama selesai" in line:
                account["wallet"] = "Deferred"
                account["status"] = "deferred"
            elif "masih wallet busy setelah pass kedua" in line:
                account["wallet"] = "Busy"
                account["status"] = "partial"
            elif "Wallet TON belum siap" in line:
                account["wallet"] = "Not ready"

            if "Mining sudah aktif" in line:
                account["mining"] = "Active"
            elif "Start mining:" in line and level == "success":
                account["mining"] = "Started"
            elif "Start mining dilewati" in line:
                account["mining"] = "Wait wallet"
            elif "Start mining gagal" in line:
                account["mining"] = "Failed"

            task_match = TASK_RE.search(line)
            if task_match:
                account["task_started"] = int(task_match.group(1))
                account["task_claimed"] = int(task_match.group(2))
                account["task_failed"] = int(task_match.group(4))

            referral_stats = REFERRAL_STATS_RE.search(line)
            if referral_stats:
                account["ref_success"] = int(referral_stats.group(1))
                account["ref_total"] = int(referral_stats.group(2))

            next_task = NEXT_TASK_RE.search(line)
            if next_task:
                account["next_task_at"] = int(next_task.group(1))

            if re.search(r"\bReferral:", line, re.I):
                account["referral"] = "OK" if level == "success" else ("Failed" if level in {"warn", "error"} else "Skipped")
            if "Team Wallet:" in line:
                account["team_wallet"] = "OK" if level == "success" else ("Failed" if level in {"warn", "error"} else "Skipped")

            complete = re.search(r"Akun\s+.+?\s+selesai\s+(?:tanpa error|dengan status\s+(\w+))", line, re.I)
            if complete:
                account["status"] = (complete.group(1) or "success").lower()

        cycle_match = CYCLE_RE.search(line)
        if cycle_match:
            self.cycle_result = {
                "success": int(cycle_match.group(1)),
                "partial": int(cycle_match.group(2)),
                "failed": int(cycle_match.group(3)),
            }
            self.cycle_number += 1

        self._dirty = True
        self._write_log(line, level)

    def _refresh_if_dirty(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        table = self.query_one("#accounts_table", DataTable)
        accounts = list(self.accounts.values())

        def cells(account: dict[str, Any]) -> list[Any]:
            task_text = f"{int(account['task_claimed'])}/{int(account['task_started'])}"
            if account["task_failed"]:
                task_text += f" !{int(account['task_failed'])}"
            next_task_at = number(account["next_task_at"])
            next_task_minutes = max(0, int((next_task_at - time.time() + 59) // 60)) if next_task_at else -1
            next_task_text = "Ready" if next_task_minutes == 0 else (f"{next_task_minutes} menit" if next_task_minutes > 0 else "-")
            return [
                str(account["label"]), status_cell(account), str(account["level"]),
                compact(account["mined"]), compact(account["atf_holding"]), compact(account["pending"]), str(account["wallet"]),
                str(account["mining"]), task_text, next_task_text,
                str(account["ref_success"]), str(account["ref_total"]), str(account["referral"]),
                str(account["team_wallet"]), str(account["connection"]),
            ]

        if table.row_count != len(accounts):
            cursor = table.cursor_row
            scroll_y = table.scroll_y
            table.clear(columns=False)
            for account in accounts:
                table.add_row(*cells(account))
            if accounts:
                table.move_cursor(row=min(cursor, len(accounts) - 1), column=0, animate=False)
                self.set_timer(0.05, lambda: table.scroll_to(y=scroll_y, animate=False))
        else:
            for row_index, account in enumerate(accounts):
                for column_index, value in enumerate(cells(account)):
                    table.update_cell_at((row_index, column_index), value, update_width=False)
        self._update_summary()

    def _update_summary(self) -> None:
        accounts = list(self.accounts.values())
        completed = sum(1 for item in accounts if item["status"] == "success")
        partial = sum(1 for item in accounts if item["status"] == "partial")
        failed = sum(1 for item in accounts if item["status"] in {"failed", "fatal"})
        wallet_ready = sum(1 for item in accounts if item["wallet"] == "Connected")
        mining_active = sum(1 for item in accounts if item["mining"] in {"Active", "Started"})
        tasks_claimed = sum(int(item["task_claimed"]) for item in accounts)
        total_mined = sum(number(item["mined"]) for item in accounts)
        total_holding = sum(number(item["atf_holding"]) for item in accounts)
        total_pending = sum(number(item["pending"]) for item in accounts)
        referral_success = sum(int(item["ref_success"]) for item in accounts)
        referral_total = sum(int(item["ref_total"]) for item in accounts)
        task_epochs = [number(item["next_task_at"]) for item in accounts if number(item["next_task_at"]) > 0]
        next_task_minutes = max(0, int((min(task_epochs) - time.time() + 59) // 60)) if task_epochs else -1
        next_task_text = "Ready" if next_task_minutes == 0 else (f"{next_task_minutes} menit" if next_task_minutes > 0 else "-")
        worker_running = self.worker is not None and self.worker.poll() is None
        if self.paused and worker_running:
            worker_text = "[bold #ffc857]PAUSED[/bold #ffc857]"
        else:
            worker_text = "[bold #78dba9]RUNNING[/bold #78dba9]" if worker_running else "[bold #ff6b88]STOPPED[/bold #ff6b88]"
        self.query_one("#global_summary", Static).update(
            f"Worker {worker_text}  │  [bold #c7b8ff]{self.total_accounts} accounts active[/bold #c7b8ff]  │  "
            f"Claim task [bold #ffb38a]{tasks_claimed}[/bold #ffb38a]  │  Next [bold]{escape(self.next_cycle)}[/bold]"
        )

        uptime = max(0, int(time.monotonic() - self.started_at))
        hours, remainder = divmod(uptime, 3600)
        minutes, seconds = divmod(remainder, 60)
        self.query_one("#summary_box", Static).update(
            "[bold #c7b8ff]ATF Cycle Summary[/bold #c7b8ff]\n\n"
            f"Accounts       : [bold]{len(accounts)}[/bold]\n"
            f"Completed      : [#78dba9]{completed}[/#78dba9]\n"
            f"Partial        : [#ffc857]{partial}[/#ffc857]\n"
            f"Failed         : [#ff6b88]{failed}[/#ff6b88]\n"
            f"Wallet ready   : [#b6a0ff]{wallet_ready}/{len(accounts)}[/#b6a0ff]\n"
            f"Mining active  : [#b6a0ff]{mining_active}/{len(accounts)}[/#b6a0ff]\n"
            f"Task claimed   : [#ffb38a]{tasks_claimed}[/#ffb38a]\n"
            f"Next task claim: [bold #ffc857]{next_task_text}[/bold #ffc857]\n"
            f"Referral OK    : [#78dba9]{referral_success}[/#78dba9]\n"
            f"Total referral : [#b6a0ff]{referral_total}[/#b6a0ff]\n"
            f"Total mined    : [bold]{total_mined:,.4f} ATF[/bold]\n"
            f"ATF holding    : [bold #ffb38a]{total_holding:,.4f} ATF[/bold #ffb38a]\n"
            f"Pending reward : [bold]{total_pending:,.4f} ATF[/bold]\n\n"
            f"Last cycle     : [#78dba9]{self.cycle_result['success']} OK[/#78dba9] / "
            f"[#ffc857]{self.cycle_result['partial']} partial[/#ffc857] / "
            f"[#ff6b88]{self.cycle_result['failed']} failed[/#ff6b88]\n"
            f"Next cycle     : [bold #ffc857]{escape(self.next_cycle)}[/bold #ffc857]\n"
            f"Uptime         : {hours:02d}:{minutes:02d}:{seconds:02d}"
        )

    def _write_log(self, message: str, level: str = "info") -> None:
        text = clean_line(str(message))
        if not text:
            return
        colors = {
            "error": "#ff6b88",
            "warn": "#ffc857",
            "success": "#78dba9",
            "debug": "#8e86a8",
            "info": "#c4baff",
        }
        stamp = datetime.now().strftime("%H:%M:%S")
        output = Text(f"{stamp} ", style="#ff9f7a")
        output.append(text, style=colors.get(level, colors["info"]))
        log = self.query_one("#log_panel", RichLog)
        at_bottom = log.scroll_y >= log.max_scroll_y - 1
        log.write(output)
        if at_bottom:
            log.scroll_end(animate=False)

    def _tick(self) -> None:
        self.query_one("#clock", Static).update(datetime.now().strftime("%d/%m/%Y  %H:%M:%S"))
        self._dirty = True
        self._update_summary()

    def _signal_worker(self) -> None:
        worker = self.worker
        if worker is None or worker.poll() is not None:
            return
        try:
            if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                worker.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                worker.send_signal(signal.SIGINT)
        except OSError:
            try:
                worker.terminate()
            except OSError:
                pass

    def _send_command(self, command: str) -> bool:
        worker = self.worker
        if worker is None or worker.stdin is None or worker.poll() is not None:
            return False
        try:
            worker.stdin.write((json.dumps({"command": command}, separators=(",", ":")) + "\n").encode("utf-8"))
            worker.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            return False

    def _worker_stopped(self, worker: subprocess.Popen[bytes], code: int) -> None:
        if self.worker is not worker:
            return
        self.worker = None
        self._write_log(f"Worker Node berhenti · exit {code}", "warn" if code == 0 else "error")
        self._dirty = True

    def action_refresh_stats(self) -> None:
        if self._closing:
            return
        if self._send_command("refresh_dashboard"):
            self.notify("Refresh state seluruh akun dimulai secara paralel")
        else:
            self.notify("Worker tidak aktif", severity="error")

    def action_toggle_pause(self) -> None:
        if not self._send_command("toggle_pause"):
            self.notify("Worker tidak aktif", severity="error")

    def action_log_page_up(self) -> None:
        self.query_one("#log_panel", RichLog).scroll_page_up(animate=False)

    def action_log_page_down(self) -> None:
        self.query_one("#log_panel", RichLog).scroll_page_down(animate=False)

    def action_log_home(self) -> None:
        self.query_one("#log_panel", RichLog).scroll_home(animate=False)

    def action_log_end(self) -> None:
        self.query_one("#log_panel", RichLog).scroll_end(animate=False)

    def action_clear_logs(self) -> None:
        self.query_one("#log_panel", RichLog).clear()
        self.notify("Panel log dibersihkan")

    async def action_quit_dashboard(self) -> None:
        if self._closing:
            return
        self._closing = True
        worker = self.worker
        if worker is not None and worker.poll() is None:
            self.notify("Menghentikan bot dengan aman…")
            if not self._send_command("shutdown"):
                self._signal_worker()
            try:
                await asyncio.wait_for(asyncio.to_thread(worker.wait), timeout=5.0)
            except asyncio.TimeoutError:
                self._signal_worker()
                try:
                    await asyncio.wait_for(asyncio.to_thread(worker.wait), timeout=2.0)
                except asyncio.TimeoutError:
                    try:
                        worker.terminate()
                    except OSError:
                        pass
        self.exit()

    def on_unmount(self) -> None:
        worker = self.worker
        if worker is not None and worker.poll() is None:
            try:
                worker.terminate()
            except OSError:
                pass


def main() -> None:
    # Explicit supaya mouse reporting tetap aktif ketika dashboard diwarisi dari
    # proses menu Node (khususnya Windows Terminal/ConPTY).
    ATFDashboard(parse_args()).run(mouse=True)


if __name__ == "__main__":
    main()
