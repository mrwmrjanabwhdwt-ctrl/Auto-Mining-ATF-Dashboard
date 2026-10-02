from __future__ import annotations

import argparse
import asyncio
import codecs
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
from typing import Any

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import DataTable, Footer, Static


MARKER = "[STATS_EVENT]"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ATF account stats dashboard")
    parser.add_argument("--node", default="node")
    parser.add_argument("--worker", type=Path, default=Path(__file__).with_name("index.js"))
    return parser.parse_args()


def number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def compact(value: Any) -> str:
    amount = number(value)
    rendered = f"{amount:,.4f}"
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def default_account(account_key: str) -> dict[str, Any]:
    return {
        "account": account_key,
        "status": "waiting",
        "username": f"@{Path(account_key).stem}",
        "wallet_address": "-",
        "wallet_holding_atf": 0,
        "mined_balance": 0,
        "is_banned": 0,
        "risk_score": 0,
        "has_qualified_dex_buy": 0,
        "buyer_protection_revoked": 0,
        "nonbuyer_rule_label": "-",
        "level_pending_withdraw_atf": 0,
        "withdraw_status": "none",
        "withdraw_amount": 0,
        "withdraw_masked_auto_fraud": None,
        "source_status": "-",
        "error": "",
    }


class StatsDashboard(App[None]):
    TITLE = "ATF Account Stats"
    CSS = """
    Screen { background: #071419; color: #e8f5f2; }
    #title { height: 3; content-align: center middle; background: #0d2630;
             border-bottom: solid #49c6a5; color: #8ff0d0; text-style: bold; }
    #summary { height: 3; padding: 1 2; background: #0a1d24; color: #ffd479; }
    #stats_table { height: 1fr; margin: 1; border: round #49c6a5; background: #071116; }
    #stats_table > .datatable--header { background: #17434a; color: #f5fbf9; text-style: bold; }
    #stats_table > .datatable--cursor { background: #28616a; color: #ffffff; }
    Footer { height: 1; background: #0d2630; color: #d9efea; }
    """
    BINDINGS = [
        Binding("q", "quit_dashboard", "Keluar", priority=True),
        Binding("r", "refresh_stats", "Refresh", priority=True),
    ]

    def __init__(self, options: argparse.Namespace) -> None:
        super().__init__()
        self.options = options
        self.worker: subprocess.Popen[bytes] | None = None
        self.accounts: dict[str, dict[str, Any]] = {}
        self.total = 0
        self.success = 0
        self.failed = 0
        self.concurrency = 0
        self.running = False
        self._dirty = True
        self._closing = False

    def compose(self) -> ComposeResult:
        yield Static("ATF ACCOUNT STATS DASHBOARD", id="title")
        yield Static("Menyiapkan maksimal 5 worker…", id="summary", markup=True)
        yield DataTable(id="stats_table", zebra_stripes=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#stats_table", DataTable)
        table.cursor_type = "row"
        for label, width in (
            ("USERNAME", 18), ("STATUS", 12), ("WALLET ADDRESS", 68),
            ("ATF HOLDING", 16), ("MINED BALANCE", 16), ("BANNED", 10),
            ("RISK SCORE", 12), ("QUALIFIED DEX", 15),
            ("PENDING WITHDRAW", 18), ("WD STATUS", 14), ("FRAUD MASK", 13), ("API STATUS", 14),
        ):
            table.add_column(label, width=width)
        table.focus()
        self.set_interval(0.25, self._render_if_dirty)
        self._start_worker()

    def _start_worker(self) -> None:
        if self.worker is not None and self.worker.poll() is None:
            self.notify("Pengecekan masih berjalan")
            return
        worker_path = self.options.worker.resolve()
        if not worker_path.is_file():
            self.notify(f"Worker tidak ditemukan: {worker_path}", severity="error")
            return

        self.accounts.clear()
        self.total = self.success = self.failed = self.concurrency = 0
        self.running = True
        self._dirty = True
        environment = os.environ.copy()
        environment["NO_COLOR"] = "1"
        environment["FORCE_COLOR"] = "0"
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
        try:
            self.worker = subprocess.Popen(
                [self.options.node, str(worker_path), "--stats-worker"],
                cwd=worker_path.parent,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                bufsize=0,
                creationflags=flags,
            )
        except Exception as error:
            self.worker = None
            self.running = False
            self.notify(f"Gagal menjalankan stats worker: {error}", severity="error")
            return
        threading.Thread(target=self._read_output, args=(self.worker,), daemon=True).start()

    def _read_output(self, worker: subprocess.Popen[bytes]) -> None:
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
                for line in parts:
                    if line.strip():
                        self.call_from_thread(self._consume_line, line)
            pending += decoder.decode(b"", final=True)
            if pending.strip():
                self.call_from_thread(self._consume_line, pending)
        finally:
            code = worker.wait()
            self.call_from_thread(self._worker_stopped, worker, code)

    def _consume_line(self, line: str) -> None:
        marker_at = line.find(MARKER)
        if marker_at < 0:
            return
        try:
            event = json.loads(line[marker_at + len(MARKER):].strip())
        except json.JSONDecodeError:
            return
        event_type = event.get("type")
        if event_type == "start":
            self.total = int(number(event.get("total")))
            self.concurrency = int(number(event.get("concurrency")))
        elif event_type == "done":
            self.total = int(number(event.get("total")))
            self.success = int(number(event.get("success")))
            self.failed = int(number(event.get("failed")))
            self.running = False
        elif event_type == "account":
            key = str(event.get("account") or "").strip()
            if not key or Path(key).name != key or not key.lower().endswith(".session"):
                return
            account = self.accounts.setdefault(key, default_account(key))
            for field in account:
                if field in event:
                    account[field] = event[field]
        self._dirty = True

    def _worker_stopped(self, worker: subprocess.Popen[bytes], code: int) -> None:
        if self.worker is worker:
            self.worker = None
            self.running = False
            if code != 0 and not self._closing:
                self.notify(f"Stats worker berhenti dengan exit {code}", severity="error")
            self._dirty = True

    def _render_if_dirty(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        table = self.query_one("#stats_table", DataTable)
        cursor = table.cursor_row
        scroll_x, scroll_y = table.scroll_x, table.scroll_y
        table.clear(columns=False)
        for item in self.accounts.values():
            status = str(item["status"])
            status_cell = Text(status.upper(), style="#70e1b3" if status == "success" else ("#ff708c" if status == "failed" else "#ffd479"))
            banned = Text("YES" if int(number(item["is_banned"])) else "NO", style="#ff708c" if int(number(item["is_banned"])) else "#70e1b3")
            qualified = "YES" if int(number(item["has_qualified_dex_buy"])) else "NO"
            withdraw_status = str(item.get("withdraw_status") or "none").lower()
            withdraw_style = {
                "approved": "#70e1b3",
                "pending": "#ffd479",
                "kyc": "#ff9f5a",
                "failed": "#ff708c",
                "unavailable": "#ff9f5a",
                "none": "#879b98",
            }.get(withdraw_status, "#879b98")
            withdraw_cell = Text("KYC/VERIFY" if withdraw_status == "kyc" else withdraw_status.upper(), style=withdraw_style)
            masked_value = item.get("withdraw_masked_auto_fraud")
            if masked_value is None:
                masked_cell = Text("-", style="#879b98")
            elif bool(masked_value):
                masked_cell = Text("YES", style="#ff708c")
            else:
                masked_cell = Text("NO", style="#70e1b3")
            table.add_row(
                str(item["username"]), status_cell, str(item["wallet_address"]),
                compact(item["wallet_holding_atf"]), compact(item["mined_balance"]), banned,
                compact(item["risk_score"]), qualified, compact(item["level_pending_withdraw_atf"]), withdraw_cell, masked_cell,
                str(item["source_status"]),
            )
        if self.accounts:
            table.move_cursor(row=min(cursor, len(self.accounts) - 1), column=0, animate=False)
            self.set_timer(0.05, lambda: table.scroll_to(x=scroll_x, y=scroll_y, animate=False))
        loaded = sum(1 for item in self.accounts.values() if item["status"] in {"success", "failed"})
        live_success = sum(1 for item in self.accounts.values() if item["status"] == "success")
        live_failed = sum(1 for item in self.accounts.values() if item["status"] == "failed")
        state = "RUNNING" if self.running else "SELESAI"
        self.query_one("#summary", Static).update(
            f"Status [bold]{state}[/bold]  │  Worker [bold]{self.concurrency or 5}/5 max[/bold]  │  "
            f"Loaded [bold]{loaded}/{self.total}[/bold]  │  Success [#70e1b3]{live_success}[/#70e1b3]  │  Failed [#ff708c]{live_failed}[/#ff708c]"
        )

    def action_refresh_stats(self) -> None:
        if not self.running:
            self._start_worker()
            self.notify("Memuat ulang stats dengan maksimal 5 worker")
        else:
            self.notify("Pengecekan masih berjalan")

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
            worker.terminate()

    async def action_quit_dashboard(self) -> None:
        self._closing = True
        worker = self.worker
        if worker is not None and worker.poll() is None:
            self._signal_worker()
            try:
                await asyncio.wait_for(asyncio.to_thread(worker.wait), timeout=3.0)
            except asyncio.TimeoutError:
                worker.terminate()
        self.exit()

    def on_unmount(self) -> None:
        worker = self.worker
        if worker is not None and worker.poll() is None:
            worker.terminate()


def main() -> None:
    StatsDashboard(parse_args()).run(mouse=True)


if __name__ == "__main__":
    main()
