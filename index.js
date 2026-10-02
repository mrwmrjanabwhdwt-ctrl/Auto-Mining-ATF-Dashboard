import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { ATFClient, ATFRequestError, buildAccountUserAgent } from './src/api.js';
import { discoverSessionAccounts, loadConfig, loadProxies } from './src/config.js';
import { acquireFreshInitData, loadTelegramCredentials } from './src/telegram.js';
import { loadTaskDefinitions } from './src/tasks.js';
import { nextRepeatableTaskEpoch } from './src/task-schedule.js';
import { ProxyHealth } from './src/proxy-health.js';
import { ReferralState } from './src/referral-state.js';
import { MultiBotError, solveTurnstileWithMultiBot } from './src/multibot.js';
import { LocalTurnstileError, solveTurnstileLocally } from './src/local-turnstile.js';
import { WalletAccountStore, buildTonProof } from './src/wallets.js';
import { syncReplacementWallet, WalletReplacementBusyError } from './src/wallet-replacement.js';
import { reportIncorrectImageCaptcha, solveImageCaptchaWith2Captcha, TwoCaptchaError } from './src/twocaptcha.js';
import {
  CAPTCHA_RETRY_REASONS,
  classifyWithdrawalStatus,
  isKycRequired,
  MIN_WITHDRAW_ATF,
  summarizeWithdrawalHistory,
  WITHDRAW_FEE_ATF,
  withdrawRetryState,
  withdrawSubmitJitterMs
} from './src/withdraw.js';
import { WalletWorkerPool } from './src/wallet-worker-pool.js';
import { WithdrawProxyPool } from './src/withdraw-proxy-pool.js';
import {
  hasVerifiedWallet,
  isCachedWalletSync,
  isExpectedWalletVerified,
  isTransientWalletSync,
  mergeWalletUser
} from './src/wallet-sync-state.js';
import {
  formatSeconds,
  getOrCreateDeviceId,
  isAbortError,
  log,
  maskIdentifier,
  printBanner,
  randomDelay,
  runWithLogContext,
  setLogLevel,
  sleep,
  solveSimpleMathQuestion
} from './src/utils.js';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const stateDirectory = path.join(rootDirectory, '.state');
const cacheDirectory = path.join(rootDirectory, '.cache');
const shutdownController = new AbortController();
let automationPaused = false;
let dashboardInputReady = false;
let dashboardRefreshHandler = null;
let dashboardRefreshRequested = false;
let dashboardRefreshPromise = null;
const accountOperationTails = new Map();

function requestShutdown(signalName) {
  if (shutdownController.signal.aborted) return;
  log.warn(`Menerima ${signalName}; menghentikan bot dengan aman...`);
  shutdownController.abort();
}

process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));
if (process.platform === 'win32') process.once('SIGBREAK', () => requestShutdown('SIGBREAK'));

async function waitWhilePaused(signal) {
  while (automationPaused && !signal.aborted) await sleep(500, signal);
}

async function runAccountExclusive(account, operation) {
  const key = String(account?.fileName || account?.name || 'account');
  const previous = accountOperationTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  accountOperationTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (accountOperationTails.get(key) === current) accountOperationTails.delete(key);
  }
}

function setupDashboardCommandInput() {
  if (dashboardInputReady || process.env.ATF_TEXTUAL_WORKER !== '1') return;
  dashboardInputReady = true;
  process.stdin.setEncoding('utf8');
  let pending = '';
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message?.command === 'toggle_pause') {
          automationPaused = !automationPaused;
          log.info(`Dashboard pause: ${automationPaused ? 'aktif' : 'nonaktif'}.`);
        } else if (message?.command === 'refresh_dashboard') {
          if (dashboardRefreshPromise) {
            log.warn('[DashboardRefresh] Refresh statistik masih berjalan; permintaan baru diabaikan.');
          } else if (typeof dashboardRefreshHandler === 'function') {
            dashboardRefreshHandler();
          } else {
            dashboardRefreshRequested = true;
            log.info('[DashboardRefresh] Permintaan refresh disimpan sampai daftar akun siap.');
          }
        } else if (message?.command === 'shutdown') {
          requestShutdown('dashboard');
        }
      } catch {
        log.warn('Command dashboard tidak valid dan diabaikan.');
      }
    }
  });
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function proxyLabel(proxy) {
  if (!proxy) return 'Direct connection';
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return 'Configured proxy';
  }
}

function resultTracker() {
  const stages = [];
  return {
    stages,
    add(name, status, message = '') {
      stages.push({ name, status, message });
    },
    get overall() {
      if (stages.some((stage) => stage.status === 'fatal')) return 'failed';
      if (stages.some((stage) => stage.status === 'failed')) return 'partial';
      return 'success';
    }
  };
}

function logBusinessResponse(label, response, tracker, stageName) {
  if (response?.status === 'success') {
    log.success(`${label}: ${response.message || 'berhasil'}`);
    tracker.add(stageName, 'success', response.message || 'success');
    return true;
  }
  const message = response?.message || response?.reason || 'tidak tersedia / cooldown';
  log.info(`${label}: ${message}`);
  tracker.add(stageName, 'skipped', message);
  return false;
}

async function pauseBetweenActions(settings, signal) {
  if (settings.delay_between_actions_ms > 0) await sleep(settings.delay_between_actions_ms, signal);
  await waitWhilePaused(signal);
}

function safeTerminalText(value, maxLength = 120) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function logDashboardProfile(user, fallbackUsername = 'account') {
  if (process.env.ATF_TEXTUAL_WORKER !== '1') return;
  const candidate = String(user?.username || fallbackUsername || 'account').replace(/^@/, '');
  const username = /^[A-Za-z0-9_]{1,64}$/.test(candidate) ? candidate : 'account';
  const holding = Math.max(0, finiteNumber(user?.wallet_holding_atf));
  log.info(`Dashboard profile: @${username} | ATF Holding ${holding.toFixed(4)} ATF.`);
}

function emitDashboardEvent(account, type, data = {}) {
  if (process.env.ATF_TEXTUAL_WORKER !== '1') return;
  const accountFile = String(account?.fileName || '').trim();
  if (!/^[A-Za-z0-9_. -]{1,160}\.session$/i.test(accountFile)) return;
  console.log(`[DASHBOARD_EVENT] ${JSON.stringify({
    version: 1,
    type,
    account: accountFile,
    ...data
  })}`);
}

function dashboardSnapshot(user, fallbackUsername = 'account') {
  const username = String(user?.username || fallbackUsername || 'account').replace(/^@/, '');
  const walletAddress = String(user?.wallet_address || '').trim();
  const miningStartedAt = Math.max(0, Number.parseInt(user?.last_mining_start || user?.mining_cycle_started_at || '0', 10) || 0);
  return {
    label: /^[A-Za-z0-9_]{1,64}$/.test(username) ? `@${username}` : String(fallbackUsername || 'account'),
    level: String(user?.miner_level ?? 1),
    mined: finiteNumber(user?.mined_balance),
    atf_holding: finiteNumber(user?.wallet_holding_atf),
    pending: finiteNumber(user?.pending_reward),
    wallet: hasVerifiedWallet(user) ? 'Connected' : (walletAddress ? 'Unverified' : '-'),
    mining: miningStartedAt > 0 ? 'Active' : '-'
  };
}

function emitDashboardSnapshot(account, user, extra = {}) {
  emitDashboardEvent(account, 'snapshot', {
    ...dashboardSnapshot(user, account?.name),
    ...extra
  });
}

function isEntryCaptchaRequired(error) {
  if (!(error instanceof ATFRequestError)) return false;
  const code = String(error.code || error.responseData?.reason || '').toLowerCase();
  const message = String(error.message || '').toLowerCase();
  return code === 'entry_captcha_required' ||
    message.includes('security check required before opening atf miner');
}

async function requestMathAnswer(client, signal) {
  const challenge = await client.getMathChallenge('start_mine');
  const question = safeTerminalText(challenge.question);
  const expiresAt = Date.now() + challenge.expires_in * 1000;

  log.info(`Security question: ${question} (kedaluwarsa ${challenge.expires_in}s)`);
  const automaticAnswer = solveSimpleMathQuestion(question);
  if (automaticAnswer !== null) {
    log.success(`Security question dijawab otomatis: ${automaticAnswer}`);
    return { challengeId: challenge.challenge_id, answer: String(automaticAnswer) };
  }

  log.warn('Format security question tidak dikenali oleh solver otomatis; beralih ke input manual.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.warn('Terminal tidak interaktif; start mining dilewati karena security question tidak dapat dijawab otomatis.');
    return null;
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (Date.now() < expiresAt) {
      const answer = (await terminal.question(chalk.white('Jawaban matematika: '), { signal })).trim();
      if (/^-?\d{1,4}$/.test(answer)) {
        return { challengeId: challenge.challenge_id, answer };
      }
      log.warn('Jawaban harus berupa angka maksimal 4 digit.');
    }
    log.warn('Security question sudah kedaluwarsa; coba lagi pada siklus berikutnya.');
    return null;
  } finally {
    terminal.close();
  }
}

function createAtfClient(auth, account, config, signal, overrides = {}) {
  const { settings, telegram } = config;
  return new ATFClient({
    initData: auth.initData,
    userInfo: auth.userInfo,
    deviceId: getOrCreateDeviceId(stateDirectory, auth.userInfo.id),
    userAgent: buildAccountUserAgent(auth.userInfo.id),
    proxy: account.proxy,
    baseUrl: settings.api_base_url,
    webappUrl: telegram.webapp_url,
    timeoutMs: settings.request_timeout_seconds * 1000,
    maxAttempts: overrides.maxAttempts ?? settings.max_attempts,
    retryDelayMs: settings.retry_delay_seconds * 1000,
    maxRetryDelayMs: settings.max_retry_delay_seconds * 1000,
    signal
  });
}

class WalletSyncBusyError extends Error {
  constructor(message, retries) {
    super(message);
    this.name = 'WalletSyncBusyError';
    this.retries = retries;
  }
}

async function ensureWalletForAccount({
  client,
  user,
  accountId,
  walletStore,
  busyRetrySeconds,
  busyMaxRetries,
  signal
}) {
  const serverAddress = String(user?.wallet_address || '').trim();
  const existing = walletStore.get(accountId);
  if (hasVerifiedWallet(user)) {
    if (existing?.managed === true && walletStore.hasManagedSecrets(accountId) && existing.address !== serverAddress) {
      throw new Error('Server masih memakai wallet berbeda dari wallet managed lokal; gunakan opsi 3 untuk melanjutkan replacement atau periksa wallet secara manual');
    }
    walletStore.recordServerWallet(accountId, user);
    log.success(`Wallet TON sudah terverifikasi: ${maskIdentifier(serverAddress, 6)}`);
    return { ready: true, user };
  }

  if (serverAddress && (!existing?.managed || existing.address !== serverAddress)) {
    walletStore.recordServerWallet(accountId, user);
    throw new Error('Akun memiliki wallet eksternal yang belum terverifikasi; verifikasi wallet tersebut melalui Mini App terlebih dahulu');
  }

  const wallet = await walletStore.getOrCreateManaged(accountId);
  if (wallet.created) {
    log.success(`Wallet TON baru dibuat dan langsung disimpan ke wallets-accounts.json: ${maskIdentifier(wallet.friendlyAddress, 8)}`);
  } else {
    log.info(`Memakai wallet TON tersimpan: ${maskIdentifier(wallet.friendlyAddress, 8)}`);
  }

  try {
    let response = null;
    let nextUser = user;
    let busyRetries = 0;
    while (!signal.aborted) {
      await waitWhilePaused(signal);
      // Proof ATF memiliki masa berlaku pendek, jadi buat proof baru pada
      // setiap retry satu-menit agar tidak kedaluwarsa selama server sibuk.
      const payload = await client.getWalletProofPayload(true);
      const proof = buildTonProof({
        address: wallet.address,
        payload: payload.payload,
        domain: client.webappUrl.hostname,
        secretKey: wallet.secretKey
      });
      response = await client.syncWallet({
        wallet: wallet.address,
        publicKey: wallet.publicKey,
        walletStateInit: wallet.walletStateInit,
        network: wallet.network,
        proof
      });

      nextUser = mergeWalletUser(nextUser, response);
      if (hasVerifiedWallet(nextUser) && !isExpectedWalletVerified(nextUser, wallet.address)) {
        walletStore.recordServerWallet(accountId, nextUser);
        throw new Error('Server mengonfirmasi wallet yang berbeda dari wallet tersimpan; sinkronisasi dihentikan demi keamanan');
      }
      if (isExpectedWalletVerified(nextUser, wallet.address)) {
        if (isTransientWalletSync(response)) {
          log.info('Wallet sudah terverifikasi; status busy/cached hanya berasal dari proses refresh atau deduplikasi server.');
        }
        break;
      }

      const transient = isTransientWalletSync(response);
      if (transient || response?.status === 'success') {
        if (isCachedWalletSync(response)) {
          log.info('Respons sync_wallet cached/dedup; membaca ulang status wallet melalui login.');
        } else if (transient) {
          log.info('Wallet belum terkonfirmasi pada respons busy; membaca ulang status user sebelum retry.');
        }

        const refreshed = await client.login();
        nextUser = mergeWalletUser(nextUser, refreshed);
        if (hasVerifiedWallet(nextUser) && !isExpectedWalletVerified(nextUser, wallet.address)) {
          walletStore.recordServerWallet(accountId, nextUser);
          throw new Error('Login mengonfirmasi wallet yang berbeda dari wallet tersimpan; sinkronisasi dihentikan demi keamanan');
        }
        if (isExpectedWalletVerified(nextUser, wallet.address)) {
          log.info('Status wallet terkonfirmasi melalui login; retry sync tidak diperlukan.');
          break;
        }
      }

      if (!transient) {
        throw new Error(response?.message || response?.reason || 'Server menolak sinkronisasi wallet');
      }

      if (busyRetries >= busyMaxRetries) {
        throw new WalletSyncBusyError(
          `Wallet belum terverifikasi setelah ${busyMaxRetries} retry respons busy/cached`,
          busyMaxRetries
        );
      }
      busyRetries += 1;
      log.warn(`Wallet belum terverifikasi setelah respons busy/cached; mencoba lagi dalam ${busyRetrySeconds}s (retry ${busyRetries}/${busyMaxRetries}).`);
      await sleep(busyRetrySeconds * 1000, signal);
    }
    if (!isExpectedWalletVerified(nextUser, wallet.address)) {
      throw new Error('Server belum mengonfirmasi wallet tersimpan sebagai terverifikasi');
    }

    walletStore.markVerified(accountId, wallet.address);
    log.success(`Wallet TON berhasil dikoneksikan dan diverifikasi: ${maskIdentifier(wallet.friendlyAddress, 8)}`);
    return { ready: true, user: nextUser };
  } finally {
    wallet.secretKey.fill(0);
  }
}

async function processTasks({ client, loginData, taskDefinitions, account, settings, tracker, signal }) {
  if (settings.task_mode === 'off') {
    tracker.add('tasks', 'skipped', 'disabled');
    return { nextClaimAt: null, started: 0, claimed: 0, failed: 0 };
  }
  if (taskDefinitions.length === 0) {
    log.warn('Task dinamis tidak tersedia; claim task dinonaktifkan untuk siklus ini.');
    tracker.add('tasks', 'failed', 'task definitions unavailable');
    return { nextClaimAt: null, started: 0, claimed: 0, failed: 0 };
  }

  const user = loginData.user || {};
  const completed = new Set(Array.isArray(user.completed_tasks) ? user.completed_tasks.map(String) : []);
  const cooldowns = loginData.task_cooldowns && typeof loginData.task_cooldowns === 'object' ? loginData.task_cooldowns : {};
  const starts = loginData.task_starts && typeof loginData.task_starts === 'object' ? loginData.task_starts : {};
  const readyByUser = new Set(account.readyTaskIds);
  let claimed = 0;
  let started = 0;
  let failed = 0;
  let reported = 0;
  let nextClaimAt = null;
  const claimQueue = [];

  function rememberNextClaim(epochSeconds) {
    const parsed = Math.max(0, Number.parseInt(epochSeconds, 10) || 0);
    if (parsed > 0 && (nextClaimAt == null || parsed < nextClaimAt)) nextClaimAt = parsed;
  }

  log.info(`Memeriksa ${taskDefinitions.length} task dari frontend ATF...`);
  for (const task of taskDefinitions) {
    await waitWhilePaused(signal);
    if (signal.aborted) break;
    const now = Math.floor(Date.now() / 1000);
    const nextAvailable = Math.max(0, Number.parseInt(cooldowns[task.id] || '0', 10) || 0);
    let startedAt = Math.max(0, Number.parseInt(starts[task.id] || '0', 10) || 0);
    const isRepeatable = task.cooldown > 0;

    if (!isRepeatable && completed.has(task.id)) continue;
    if (nextAvailable > now) {
      if (isRepeatable) rememberNextClaim(nextAvailable);
      continue;
    }
    if (task.manualReview) {
      log.task(task.title, chalk.gray('manual review — dilewati'));
      reported += 1;
      continue;
    }

    const explicitlyReady = readyByUser.has(task.id);

    if (settings.task_mode === 'report') {
      const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
      const reportMessage = startedAt > 0 && elapsed < task.minSeconds
        ? `processing, tunggu ${task.minSeconds - elapsed}s`
        : `tersedia — ${task.link}`;
      log.task(task.title, chalk.yellow(reportMessage));
      reported += 1;
      if (isRepeatable) rememberNextClaim(now);
      continue;
    }

    // Pada frontend ATF, klik link task juga mendaftarkan start_task. Tanpa
    // langkah ini server tidak membuat task_starts dan claim tidak akan siap.
    const staleRepeatStart = isRepeatable && startedAt > 0 && (
      (nextAvailable > 0 && startedAt < nextAvailable) || now - startedAt >= task.cooldown
    );
    if ((startedAt === 0 || staleRepeatStart) && !explicitlyReady) {
      const clickedAt = Math.floor(Date.now() / 1000);
      try {
        log.task(task.title, chalk.cyan(`klik link task — ${task.link}`));
        const startResponse = await client.startTask(task.id, clickedAt);
        if (startResponse?.status !== 'success') {
          log.task(task.title, chalk.yellow(startResponse?.message || 'task belum dapat dimulai'));
          failed += 1;
          if (isRepeatable) rememberNextClaim(clickedAt);
          await pauseBetweenActions(settings, signal);
          continue;
        }

        const serverStartedAt = Math.max(0, Number.parseInt(
          startResponse.started_at ?? startResponse.start_time ?? startResponse.client_started_at ?? clickedAt,
          10
        ) || 0);
        startedAt = serverStartedAt >= clickedAt - 300 && serverStartedAt <= clickedAt + 5
          ? serverStartedAt
          : clickedAt;
        started += 1;
        log.task(task.title, chalk.green('task berhasil dimulai'));
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.task(task.title, chalk.red(`klik/start task gagal: ${error.message}`));
        failed += 1;
        if (isRepeatable) rememberNextClaim(clickedAt);
        await pauseBetweenActions(settings, signal);
        continue;
      }
      await pauseBetweenActions(settings, signal);
    }

    claimQueue.push({ task, startedAt, explicitlyReady });
  }

  // Semua task dimulai lebih dulu agar waktu tunggu berjalan paralel. Setelah
  // itu setiap task di-claim segera setelah minimum waktunya terpenuhi.
  for (const { task, startedAt, explicitlyReady } of claimQueue) {
    await waitWhilePaused(signal);
    if (signal.aborted) break;
    const readyAt = explicitlyReady ? Date.now() : (startedAt + task.minSeconds) * 1000;
    const waitSeconds = Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
    if (waitSeconds > 0) {
      log.task(task.title, chalk.yellow(`processing, tunggu ${waitSeconds}s sebelum claim`));
      await sleep(Math.max(0, readyAt - Date.now()), signal);
    }
    await waitWhilePaused(signal);

    try {
      const response = await client.claimTask(task.id, startedAt);
      if (response?.status === 'success') {
        log.task(task.title, chalk.green(`claim berhasil (+${response.reward ?? task.reward} ATF)`));
        claimed += 1;
        if (task.cooldown > 0) {
          const responseNext = response.next_available_at ?? response.next_available ?? response.cooldown_until;
          const parsedNext = Math.max(0, Number.parseInt(responseNext || '0', 10) || 0);
          rememberNextClaim(parsedNext > Math.floor(Date.now() / 1000)
            ? parsedNext
            : Math.floor(Date.now() / 1000) + task.cooldown);
        }
      } else {
        log.task(task.title, chalk.yellow(response?.message || 'belum terverifikasi'));
        failed += 1;
        if (task.cooldown > 0) rememberNextClaim(Math.floor(Date.now() / 1000));
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.task(task.title, chalk.red(`claim gagal: ${error.message}`));
      failed += 1;
      if (task.cooldown > 0) rememberNextClaim(Math.floor(Date.now() / 1000));
    }
    await pauseBetweenActions(settings, signal);
  }

  const summary = `${started} started, ${claimed} claimed, ${reported} reported, ${failed} failed`;
  tracker.add('tasks', failed > 0 ? 'failed' : 'success', summary);
  log.info(`Ringkasan task: ${summary}.`);
  return { nextClaimAt, started, claimed, failed };
}

async function processAccount(options) {
  return runAccountExclusive(options?.account, () => runWithLogContext(
    { accountFile: options?.account?.fileName },
    () => processAccountScoped(options)
  ));
}

async function processAccountScoped({
  account,
  index,
  total,
  config,
  credentials,
  taskDefinitions,
  proxyHealth,
  walletStore,
  walletBusyMaxRetries = null,
  dashboardRunMode = 'main',
  signal
}) {
  await waitWhilePaused(signal);
  const tracker = resultTracker();
  const { settings, telegram } = config;
  log.account(index + 1, total, `${account.name} (${account.fileName})`);
  log.info(`ATF API: ${proxyLabel(account.proxy)}. Telegram session: direct MTProto connection.`);
  emitDashboardEvent(account, 'status', {
    status: dashboardRunMode === 'wallet_worker' ? 'worker' : 'running',
    connection: proxyLabel(account.proxy)
  });

  if (account.proxy && !proxyHealth.canUse(account.proxy)) {
    const remaining = proxyHealth.cooldownRemainingSeconds(account.proxy);
    log.warn(`Proxy sedang dikarantina ${formatSeconds(remaining)}; akun dilewati tanpa fallback ke koneksi langsung.`);
    tracker.add('proxy', 'fatal', 'proxy cooldown');
    emitDashboardEvent(account, 'status', { status: 'failed' });
    return tracker;
  }

  let auth;
  try {
    log.info('Meminta initData WebApp baru dari Telegram session...');
    auth = await acquireFreshInitData({ account, telegramConfig: telegram, credentials });
    log.success(`Telegram auth aktif: ${auth.userInfo.firstName} (@${auth.userInfo.username || '-'} | ID ${maskIdentifier(auth.userInfo.id)})`);
    tracker.add('telegram_auth', 'success');
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.error(`Telegram session gagal: ${error.message}`);
    tracker.add('telegram_auth', 'fatal', error.message);
    emitDashboardEvent(account, 'status', { status: 'failed' });
    return tracker;
  }

  const client = createAtfClient(auth, account, config, signal);

  let loginData;
  try {
    loginData = await client.login();
    proxyHealth.recordSuccess(account.proxy);
    tracker.add('atf_login', 'success');
  } catch (error) {
    if (isAbortError(error)) throw error;
    const captchaHint = isEntryCaptchaRequired(error)
      ? ' Buka Mini App dan selesaikan captcha entry terlebih dahulu.'
      : '';
    log.error(`Login ATF gagal: ${error.message}.${captchaHint}`);
    if (account.proxy && error instanceof ATFRequestError && error.status === 0) {
      const health = proxyHealth.recordFailure(account.proxy);
      if (health.disabled) log.warn('Proxy mencapai batas kegagalan dan dikarantina sementara.');
    }
    tracker.add('atf_login', 'fatal', error.message);
    emitDashboardEvent(account, 'status', { status: 'failed' });
    return tracker;
  }

  let user = loginData.user;
  log.success(`Level ${user.miner_level ?? 1} | Mined ${finiteNumber(user.mined_balance).toFixed(4)} ATF | Pending Reward ${finiteNumber(user.pending_reward).toFixed(4)} ATF`);
  logDashboardProfile(user, auth.userInfo.username || account.name);
  emitDashboardSnapshot(account, user, {
    status: dashboardRunMode === 'wallet_worker' ? 'worker' : 'running',
    connection: proxyLabel(account.proxy),
    next_task_at: nextRepeatableTaskEpoch(loginData, taskDefinitions)
  });

  if (process.env.ATF_TEXTUAL_WORKER === '1') {
    try {
      const friends = await client.getFriends();
      if (friends?.status === 'success') {
        const totalReferrals = Math.max(0, Number.parseInt(friends.total || '0', 10) || 0);
        const successfulReferrals = Math.max(0, Number.parseInt(friends.success ?? user.ref_success ?? '0', 10) || 0);
        log.info(`Referral stats: ${successfulReferrals} success / ${totalReferrals} total.`);
      } else {
        log.warn(`Referral stats tidak tersedia: ${friends?.message || 'respons tidak valid'}`);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Referral stats gagal dimuat: ${error.message}`);
    }
    await pauseBetweenActions(settings, signal);
  }

  let walletReady = false;
  try {
    const walletResult = await ensureWalletForAccount({
      client,
      user,
      accountId: auth.userInfo.id,
      walletStore,
      busyRetrySeconds: settings.wallet_busy_retry_seconds,
      busyMaxRetries: walletBusyMaxRetries ?? settings.wallet_busy_max_retries,
      signal
    });
    walletReady = walletResult.ready;
    user = walletResult.user;
    logDashboardProfile(user, auth.userInfo.username || account.name);
    emitDashboardSnapshot(account, user, {
      status: dashboardRunMode === 'wallet_worker' ? 'worker' : 'running'
    });
    tracker.add('wallet', 'success', 'connected and verified');
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof WalletSyncBusyError) {
      log.warn(`${error.message}; akun membutuhkan retry lanjutan.`);
      tracker.add('wallet', 'deferred', error.message);
      tracker.deferredWallet = true;
      emitDashboardEvent(account, 'status', {
        status: dashboardRunMode === 'wallet_worker' ? 'worker' : 'deferred',
        wallet: 'Retry worker'
      });
      return tracker;
    }
    log.warn(`Wallet TON belum siap: ${error.message}`);
    tracker.add('wallet', 'failed', error.message);
  }
  await pauseBetweenActions(settings, signal);

  if (settings.auto_sync_mining_state) {
    try {
      const response = await client.syncMiningState();
      logBusinessResponse('Sync mining', response, tracker, 'sync_mining');
      if (response?.user && typeof response.user === 'object') user = { ...user, ...response.user };
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Sync mining gagal: ${error.message}`);
      tracker.add('sync_mining', 'failed', error.message);
    }
    await pauseBetweenActions(settings, signal);
  }

  const claimable = Math.max(0, finiteNumber(user.claimable_now ?? user.mined_balance));
  if (settings.auto_claim && claimable > 0 && walletReady) {
    try {
      const response = await client.claim(claimable);
      logBusinessResponse(`Claim ${claimable.toFixed(4)} ATF`, response, tracker, 'claim');
      if (response?.status === 'success') {
        user = { ...user, mined_balance: response.new_pool_balance ?? response.new_balance ?? user.mined_balance, claimable_now: 0 };
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Claim gagal: ${error.message}`);
      tracker.add('claim', 'failed', error.message);
    }
    await pauseBetweenActions(settings, signal);
  } else {
    const claimReason = !settings.auto_claim ? 'disabled' : !walletReady ? 'wallet not verified' : 'nothing claimable';
    tracker.add('claim', 'skipped', claimReason);
  }

  if (settings.auto_start_mining && walletReady) {
    const miningStartedAt = Math.max(0, Number.parseInt(user.last_mining_start || '0', 10) || 0);
    if (miningStartedAt > 0) {
      log.info('Mining sudah aktif; security question tidak diminta ulang.');
      tracker.add('start_mining', 'skipped', 'already active');
    } else {
      try {
        const challenge = await requestMathAnswer(client, signal);
        if (challenge) {
          const response = await client.startMine(challenge);
          logBusinessResponse('Start mining', response, tracker, 'start_mining');
        } else {
          tracker.add('start_mining', 'skipped', 'security question belum dijawab');
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.warn(`Start mining gagal: ${error.message}`);
        tracker.add('start_mining', 'failed', error.message);
      }
    }
    await pauseBetweenActions(settings, signal);
  } else if (settings.auto_start_mining) {
    log.info('Start mining dilewati sampai wallet TON terverifikasi.');
    tracker.add('start_mining', 'skipped', 'wallet not verified');
  }

  if (settings.auto_boost && walletReady) {
    try {
      const response = await client.activateBoost(Math.max(0, finiteNumber(user.claimable_now)));
      logBusinessResponse('Boost', response, tracker, 'boost');
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Boost gagal: ${error.message}`);
      tracker.add('boost', 'failed', error.message);
    }
    await pauseBetweenActions(settings, signal);
  } else if (settings.auto_boost) {
    tracker.add('boost', 'skipped', 'wallet not verified');
  }

  const taskResult = await processTasks({
    client,
    loginData: { ...loginData, user },
    taskDefinitions,
    account,
    settings,
    tracker,
    signal
  });
  tracker.nextTaskAt = taskResult?.nextClaimAt || null;
  emitDashboardEvent(account, 'task', {
    task_started: taskResult?.started || 0,
    task_claimed: taskResult?.claimed || 0,
    task_failed: taskResult?.failed || 0,
    next_task_at: tracker.nextTaskAt || 0
  });
  if (taskResult?.nextClaimAt) {
    const remainingMinutes = Math.max(0, Math.ceil((taskResult.nextClaimAt - Date.now() / 1000) / 60));
    log.info(`Next claim task: ${remainingMinutes} menit (epoch ${taskResult.nextClaimAt}).`);
  }

  if (settings.auto_claim_referrals) {
    try {
      const response = await client.claimReferrals();
      logBusinessResponse('Referral', response, tracker, 'referrals');
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Referral gagal: ${error.message}`);
      tracker.add('referrals', 'failed', error.message);
    }
    await pauseBetweenActions(settings, signal);
  }

  if (settings.auto_claim_team_wallet) {
    try {
      const response = await client.claimTeamWallet();
      logBusinessResponse('Team Wallet', response, tracker, 'team_wallet');
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Team Wallet gagal: ${error.message}`);
      tracker.add('team_wallet', 'failed', error.message);
    }
  }

  if (dashboardRunMode === 'wallet_worker' && process.env.ATF_TEXTUAL_WORKER === '1') {
    try {
      const refreshed = await client.login();
      if (refreshed?.user && typeof refreshed.user === 'object') user = { ...user, ...refreshed.user };
      emitDashboardSnapshot(account, user, {
        status: tracker.overall,
        next_task_at: nextRepeatableTaskEpoch(refreshed, taskDefinitions)
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Refresh snapshot akhir worker gagal: ${error.message}`);
    }
  }

  const failures = tracker.stages.filter((stage) => ['failed', 'fatal'].includes(stage.status));
  if (tracker.overall === 'success') {
    log.success(`Akun ${account.name} selesai tanpa error.`);
  } else {
    log.warn(`Akun ${account.name} selesai dengan status ${tracker.overall}: ${failures.map((stage) => stage.name).join(', ')}`);
  }
  emitDashboardEvent(account, 'status', { status: tracker.overall });
  return tracker;
}

async function countdownUntil(targetTime, signal) {
  while (!signal.aborted) {
    await waitWhilePaused(signal);
    const remaining = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
    if (remaining <= 0) break;
    process.stdout.write(`\r${chalk.blue('[COUNTDOWN]')} Siklus berikutnya: ${chalk.yellow(formatSeconds(remaining))}   `);
    const updateMs = remaining > 60 ? Math.min(30_000, remaining * 1000) : 1000;
    await sleep(updateMs, signal);
  }
  if (!signal.aborted) process.stdout.write('\n\n');
}

function loadCredentialsWithHint() {
  try {
    return loadTelegramCredentials();
  } catch (error) {
    throw new Error(`${error.message}. Salin .env.example menjadi .env lalu isi kredensial Anda.`);
  }
}

async function registerReferralAccounts() {
  const config = loadConfig(rootDirectory);
  setLogLevel(config.settings.log_level);
  const referralCode = config.telegram.referral_code;
  if (!/^\d{4,20}$/.test(referralCode)) {
    throw new Error('Isi telegram.referral_code pada config.json sebelum mendaftarkan referral');
  }

  dotenv.config({ path: path.join(rootDirectory, '.env'), override: true, quiet: true });
  const turnstileProvider = await chooseTurnstileProvider();
  if (!turnstileProvider) {
    log.info('Pendaftaran referral dibatalkan.');
    return;
  }
  const multibotApiKey = String(process.env.MULTIBOT_API_KEY || '').trim();
  const useAccountProxyForMultiBot = /^(1|true|yes)$/i.test(String(process.env.MULTIBOT_USE_ACCOUNT_PROXY || ''));
  const localSolverUrl = String(process.env.LOCAL_TURNSTILE_SOLVER_URL || 'http://127.0.0.1:8000').trim();
  const withdrawProxies = loadProxies(rootDirectory);
  const accounts = discoverSessionAccounts(rootDirectory, config.telegram, withdrawProxies);
  if (accounts.length === 0) {
    log.warn(`Tidak ada file *.session di ${path.resolve(rootDirectory, config.telegram.session_directory)}`);
    return;
  }

  const credentials = loadCredentialsWithHint();
  const referralState = new ReferralState(path.join(stateDirectory, 'referrals.json'));
  const proxyHealth = new ProxyHealth({
    statePath: path.join(stateDirectory, 'proxy-health.json'),
    failureThreshold: config.settings.proxy_failure_threshold,
    cooldownMinutes: config.settings.proxy_cooldown_minutes
  });
  let registered = 0;
  let skipped = 0;
  let securityPending = 0;
  let failed = 0;

  log.info(`Mendaftarkan ${accounts.length} session dengan referral ${referralCode} memakai solver ${turnstileProvider === 'local' ? 'lokal' : 'MultiBot'}...`);
  for (let index = 0; index < accounts.length && !shutdownController.signal.aborted; index += 1) {
    const account = accounts[index];
    log.account(index + 1, accounts.length, `${account.name} (${account.fileName})`);
    const plan = referralState.plan(account.sessionPath, referralCode);

    if (!plan?.needsFinalize) {
      log.success('Referral sudah pernah difinalisasi oleh tool ini; dilewati.');
      skipped += 1;
      continue;
    }
    if (account.proxy && !proxyHealth.canUse(account.proxy)) {
      log.warn(`Proxy sedang dikarantina ${formatSeconds(proxyHealth.cooldownRemainingSeconds(account.proxy))}; akun dilewati.`);
      failed += 1;
      continue;
    }

    try {
      const auth = await acquireFreshInitData({
        account,
        telegramConfig: config.telegram,
        credentials,
        referral: {
          code: plan.code,
          startBot: plan.needsStartBot,
          onBotStarted: () => {
            referralState.markBotStarted(plan.key);
            log.success(`Telegram StartBot /start ${plan.code} berhasil dikirim.`);
          }
        }
      });
      const client = createAtfClient(auth, account, config, shutdownController.signal);
      try {
        await client.login(plan.code);
      } catch (error) {
        if (!isEntryCaptchaRequired(error)) throw error;
        if (turnstileProvider === 'multibot' && !multibotApiKey) {
          throw new MultiBotError('Turnstile diperlukan, tetapi MULTIBOT_API_KEY belum diisi di .env', 'MULTIBOT_API_KEY_MISSING');
        }

        const solverLabel = turnstileProvider === 'local' ? 'LocalSolver' : 'MultiBot';
        log.info(`Cloudflare Turnstile terdeteksi; meminta token ke ${turnstileProvider === 'local' ? 'solver lokal' : 'MultiBot'}...`);
        try {
          log.info(`[${solverLabel}] Mengambil status dan site key Turnstile dari server ATF...`);
          const captchaStatus = await client.getEntryCaptchaStatus();
          if (captchaStatus.captcha_enabled && captchaStatus.captcha_required) {
            if (!captchaStatus.config_ready || !captchaStatus.site_key) {
              const ErrorType = turnstileProvider === 'local' ? LocalTurnstileError : MultiBotError;
              throw new ErrorType('Konfigurasi/site key Turnstile belum tersedia dari server ATF', 'ATF_CAPTCHA_CONFIG_MISSING');
            }
            log.info(`[${solverLabel}] Site key tersedia; menyiapkan task solver.`);
            const sharedSolverOptions = {
              pageUrl: config.telegram.webapp_url,
              siteKey: captchaStatus.site_key,
              signal: shutdownController.signal,
              onProgress: (message) => log.info(`[${solverLabel}] ${message}`)
            };
            const captchaToken = turnstileProvider === 'local'
              ? await solveTurnstileLocally({ ...sharedSolverOptions, baseUrl: localSolverUrl })
              : await solveTurnstileWithMultiBot({
                  ...sharedSolverOptions,
                  apiKey: multibotApiKey,
                  proxy: useAccountProxyForMultiBot ? account.proxy : ''
                });
            log.info(`[${solverLabel}] Mengirim token ke endpoint verifikasi ATF...`);
            await client.verifyEntryCaptcha(captchaToken);
            log.success(`Turnstile berhasil diselesaikan dan diverifikasi melalui ${turnstileProvider === 'local' ? 'solver lokal' : 'MultiBot'}.`);
          } else {
            log.info('Server ATF menyatakan security check sudah tidak diperlukan; melanjutkan login.');
          }
        } catch (captchaError) {
          if (isAbortError(captchaError)) throw captchaError;
          if (captchaError instanceof MultiBotError || captchaError instanceof LocalTurnstileError) throw captchaError;
          const ErrorType = turnstileProvider === 'local' ? LocalTurnstileError : MultiBotError;
          throw new ErrorType(`Proses Turnstile gagal: ${safeTerminalText(captchaError.message, 220)}`, 'ATF_CAPTCHA_FLOW_FAILED');
        }

        // Token hanya berlaku sekali; login langsung diulang setelah server ATF menerimanya.
        log.info(`[${solverLabel}] Mengulang login referral setelah verifikasi Turnstile...`);
        await client.login(plan.code);
      }
      referralState.markCompleted(plan.key);
      proxyHealth.recordSuccess(account.proxy);
      log.success(`Akun berhasil difinalisasi dengan ref_code ${plan.code}.`);
      registered += 1;
    } catch (error) {
      if (isAbortError(error)) break;
      if (isEntryCaptchaRequired(error) || error instanceof MultiBotError || error instanceof LocalTurnstileError) {
        log.warn(`Pendaftaran ditunda: ${safeTerminalText(error.message, 240)}. /start referral tidak akan dikirim ulang.`);
        securityPending += 1;
        continue;
      }
      log.error(`Pendaftaran referral gagal: ${error.message}`);
      if (account.proxy && error instanceof ATFRequestError && error.status === 0) {
        proxyHealth.recordFailure(account.proxy);
      }
      failed += 1;
    }

    if (index < accounts.length - 1 && !shutdownController.signal.aborted) {
      const { min, max } = config.settings.delay_between_accounts_seconds;
      await randomDelay(min, max, shutdownController.signal);
    }
  }

  log.info(`Pendaftaran referral selesai: ${registered} berhasil, ${skipped} dilewati, ${securityPending} menunggu security check, ${failed} gagal.`);
  if (securityPending > 0) {
    const hint = turnstileProvider === 'local'
      ? `pastikan server lokal aktif di ${localSolverUrl}`
      : 'periksa MULTIBOT_API_KEY/saldo MultiBot';
    log.warn(`${securityPending} akun belum difinalisasi. ${hint}, lalu jalankan opsi 2 lagi.`);
  }
}

async function replaceWalletAccount({
  account,
  index,
  total,
  config,
  credentials,
  proxyHealth,
  walletStore,
  askConfirmation,
  busyMaxRetries,
  signal
}) {
  return runAccountExclusive(account, () => runWithLogContext({ accountFile: account.fileName }, async () => {
    log.account(index + 1, total, `${account.name} (${account.fileName})`);
    if (account.proxy && !proxyHealth.canUse(account.proxy)) {
      log.warn(`Proxy masih dikarantina ${formatSeconds(proxyHealth.cooldownRemainingSeconds(account.proxy))}; akun dilewati.`);
      return { status: 'failed' };
    }

    let auth;
    let client;
    let loginData;
    try {
      auth = await acquireFreshInitData({ account, telegramConfig: config.telegram, credentials });
      client = createAtfClient(auth, account, config, signal);
      loginData = await client.login();
      proxyHealth.recordSuccess(account.proxy);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (account.proxy && error instanceof ATFRequestError && error.status === 0) proxyHealth.recordFailure(account.proxy);
      log.warn(`Tidak dapat memeriksa akun: ${error.message}`);
      return { status: 'failed' };
    }

    const accountId = String(auth.userInfo.id);
    const record = walletStore.get(accountId);
    const hasSecrets = walletStore.hasManagedSecrets(accountId);
    const pendingReplacement = hasSecrets && record?.replacement_pending === true;
    if (hasSecrets && !pendingReplacement) {
      try {
        const storedWallet = await walletStore.getOrCreateManaged(accountId);
        storedWallet.secretKey.fill(0);
      } catch (error) {
        log.warn(`Secret lokal ditemukan tetapi tidak cocok/valid: ${error.message}. Wallet tidak diganti otomatis.`);
        return { status: 'failed' };
      }
      log.success(`Skip @${auth.userInfo.username || account.name}: mnemonic/private key sudah tersimpan.`);
      return { status: 'skipped' };
    }

    if (!pendingReplacement) {
      const decision = await askConfirmation({
        username: auth.userInfo.username || loginData?.user?.username || account.name,
        accountId,
        currentAddress: loginData?.user?.wallet_address || record?.address || ''
      });
      if (decision === 'cancel') return { status: 'cancelled' };
      if (decision !== 'replace') {
        log.info(`Skip @${auth.userInfo.username || account.name}: wallet tidak diubah.`);
        return { status: 'skipped' };
      }
    }

    try {
      const result = await syncReplacementWallet({
        client,
        user: loginData?.user || {},
        accountId,
        walletStore,
        busyRetrySeconds: config.settings.wallet_busy_retry_seconds,
        busyMaxRetries,
        signal,
        onCreated: (wallet) => log.success(`Wallet pengganti dibuat dan mnemonic langsung disimpan: ${maskIdentifier(wallet.friendlyAddress, 8)}`),
        onResumed: (wallet) => log.info(`Melanjutkan replacement wallet pending: ${maskIdentifier(wallet.friendlyAddress, 8)}`),
        onRetry: ({ retry, maxRetries, delaySeconds }) => log.warn(`Replacement wallet masih busy/cached; retry ${delaySeconds}s (${retry}/${maxRetries}).`)
      });
      log.success(`Wallet ATF berhasil diganti: ${maskIdentifier(result.wallet.friendlyAddress, 8)}`);
      return { status: 'success' };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof WalletReplacementBusyError) {
        log.warn(`${error.message}; disimpan pending untuk retry worker.`);
        return { status: 'deferred' };
      }
      log.warn(`Penggantian wallet gagal: ${error.message}. Mnemonic wallet baru tetap tersimpan untuk recovery.`);
      return { status: 'failed' };
    }
  }));
}

async function replaceMissingWalletAccounts() {
  const config = loadConfig(rootDirectory);
  setLogLevel(config.settings.log_level);
  dotenv.config({ path: path.join(rootDirectory, '.env'), override: true, quiet: true });
  const accounts = discoverSessionAccounts(rootDirectory, config.telegram, loadProxies(rootDirectory));
  if (accounts.length === 0) {
    log.warn(`Tidak ada file *.session di ${path.resolve(rootDirectory, config.telegram.session_directory)}`);
    return;
  }

  const credentials = loadCredentialsWithHint();
  const walletStore = new WalletAccountStore(
    path.join(rootDirectory, config.telegram.wallet_accounts_file),
    process.env.WALLET_KEYSTORE_PASSWORD || ''
  );
  const proxyHealth = new ProxyHealth({
    statePath: path.join(stateDirectory, 'proxy-health.json'),
    failureThreshold: config.settings.proxy_failure_threshold,
    cooldownMinutes: config.settings.proxy_cooldown_minutes
  });
  const deferred = [];
  const counts = { success: 0, skipped: 0, failed: 0, deferred: 0 };

  log.warn('Mode ganti wallet hanya memproses akun tanpa mnemonic/private key lokal. Jawaban default adalah Skip.');
  for (let index = 0; index < accounts.length && !shutdownController.signal.aborted; index += 1) {
    const account = accounts[index];
    const result = await replaceWalletAccount({
      account,
      index,
      total: accounts.length,
      config,
      credentials,
      proxyHealth,
      walletStore,
      askConfirmation: confirmWalletReplacement,
      busyMaxRetries: Math.min(config.settings.wallet_busy_max_retries, 1),
      signal: shutdownController.signal
    });
    if (result.status === 'cancelled') {
      log.info('Pemilihan wallet dibatalkan; akun berikutnya tidak dipindai.');
      break;
    }
    counts[result.status] = (counts[result.status] || 0) + 1;
    if (result.status === 'deferred') deferred.push({ account, index });
  }

  log.info(`Pemindaian selesai: ${counts.success} diganti, ${counts.skipped} skip, ${counts.deferred} pending, ${counts.failed} gagal.`);
  if (deferred.length === 0 || shutdownController.signal.aborted) return;

  let workerSuccess = 0;
  let workerFailed = 0;
  const maxWorkers = Math.min(5, config.settings.wallet_worker_concurrency);
  log.info(`Retry ${deferred.length} wallet pending dimulai setelah semua akun dipindai; maksimal ${maxWorkers} worker.`);
  const workers = new WalletWorkerPool({
    maxWorkers,
    retryDelayMs: config.settings.wallet_busy_retry_seconds * 1000,
    signal: shutdownController.signal,
    runJob: async (job, attempt) => {
      log.info(`[ReplaceWalletWorker] ${job.account.name}: percobaan #${attempt}.`);
      const result = await replaceWalletAccount({
        account: job.account,
        index: job.index,
        total: accounts.length,
        config,
        credentials,
        proxyHealth,
        walletStore,
        askConfirmation: async () => 'replace',
        busyMaxRetries: 0,
        signal: shutdownController.signal
      });
      return { retry: result.status === 'deferred', status: result.status };
    },
    onEvent: (event) => {
      const name = event.job?.account?.name || 'akun';
      if (event.type === 'retry_wait') {
        log.warn(`[ReplaceWalletWorker] ${name} masih busy; retry ${config.settings.wallet_busy_retry_seconds}s.`);
      } else if (event.type === 'completed') {
        if (event.result?.status === 'success') {
          workerSuccess += 1;
          log.success(`[ReplaceWalletWorker] ${name} berhasil.`);
        } else {
          workerFailed += 1;
          log.warn(`[ReplaceWalletWorker] ${name} berhenti dengan status ${event.result?.status || 'unknown'}.`);
        }
      } else if (event.type === 'failed') {
        workerFailed += 1;
        log.error(`[ReplaceWalletWorker] ${name} error: ${event.error?.message || 'unknown error'}`);
      }
    }
  });
  for (const job of deferred) workers.enqueue({ key: job.account.fileName, ...job });
  await workers.waitForIdle();
  if (!shutdownController.signal.aborted) log.info(`Retry replacement selesai: ${workerSuccess} berhasil, ${workerFailed} gagal.`);
}

async function withdrawAccount({ account, index, total, config, credentials, proxyHealth, proxyPool, twoCaptchaApiKey, signal }) {
  return runAccountExclusive(account, () => runWithLogContext({ accountFile: account.fileName }, async () => {
    log.account(index + 1, total, `${account.name} (${account.fileName})`);
    const transportError = (error) => error instanceof ATFRequestError && error.status === 0;
    const directOnly = proxyPool.configuredCount === 0 && !account.proxy;
    let directUsed = false;
    let firstProxy = true;
    let activeProxy = null;
    let auth;
    let client;
    let loginData;

    try {
      auth = await acquireFreshInitData({ account, telegramConfig: config.telegram, credentials });
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Telegram initData withdraw gagal: ${error.message}`);
      return 'failed';
    }

    const connectWithUnusedProxy = async (reason = 'login awal') => {
      while (!signal.aborted) {
        const preferred = firstProxy ? account.proxy : null;
        firstProxy = false;
        const nextProxy = directOnly && !directUsed ? null : proxyPool.take(preferred);
        if (!nextProxy && !(directOnly && !directUsed)) {
          const error = new Error(`Proxy unik yang belum dipakai sudah habis (${proxyPool.usedCount} terpakai); ${reason} tidak dapat di-retry.`);
          error.code = 'WITHDRAW_PROXY_EXHAUSTED';
          throw error;
        }

        directUsed = directUsed || !nextProxy;
        activeProxy = nextProxy;
        const connection = proxyLabel(activeProxy);
        client = createAtfClient(auth, { ...account, proxy: activeProxy }, config, signal, { maxAttempts: 1 });
        try {
          loginData = await client.login();
          proxyHealth.recordSuccess(activeProxy);
          log.success(`Login @${auth.userInfo.username || account.name} berhasil via ${connection}.`);
          return;
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (!transportError(error)) throw error;
          if (activeProxy) proxyHealth.recordFailure(activeProxy);
          log.warn(`Proxy ${connection} gagal saat ${reason}: ${error.message}. Mengambil proxy unik berikutnya.`);
          activeProxy = null;
          if (directOnly) throw error;
        }
      }
      throw new Error('Proses withdraw dihentikan');
    };

    const requestWithProxyRotation = async (label, operation) => {
      while (!signal.aborted) {
        try {
          return await operation(client);
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (!transportError(error)) throw error;
          const failedProxy = activeProxy;
          const connection = proxyLabel(failedProxy);
          if (failedProxy) proxyHealth.recordFailure(failedProxy);
          activeProxy = null;
          log.warn(`Proxy ${connection} gagal saat ${label}: ${error.message}. Retry memakai proxy unik berikutnya.`);
          if (directOnly) throw error;
          await connectWithUnusedProxy(label);
        }
      }
      throw new Error('Proses withdraw dihentikan');
    };

    try {
      await connectWithUnusedProxy();
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Login withdraw gagal: ${error.message}`);
      return 'failed';
    }

    let user = loginData?.user || {};
    if (!hasVerifiedWallet(user)) {
      log.warn('Skip: wallet TON belum terhubung/terverifikasi.');
      return 'skipped';
    }

    const initialMined = Math.max(0, finiteNumber(user.mined_balance));
    const pendingReward = Math.max(0, finiteNumber(user.pending_reward));
    log.info(`Saldo awal: Mined ${initialMined.toFixed(4)} ATF | Pending Reward ${pendingReward.toFixed(4)} ATF.`);

    if (pendingReward > 0) {
      try {
        const claimRequestId = crypto.randomUUID();
        const claimResponse = await requestWithProxyRotation(
          'claim Pending Reward',
          (activeClient) => activeClient.claim(pendingReward, claimRequestId)
        );
        if (claimResponse?.status === 'success') {
          log.success(`Pending Reward ${pendingReward.toFixed(4)} ATF berhasil di-claim.`);
        } else {
          log.warn(`Claim Pending Reward belum berhasil: ${claimResponse?.message || 'respons tidak valid'}.`);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error?.code === 'WITHDRAW_PROXY_EXHAUSTED') {
          log.warn(`Claim Pending Reward dihentikan: ${error.message}`);
          return 'failed';
        }
        log.warn(`Claim Pending Reward gagal: ${error.message}. Saldo akan dicek ulang sebelum withdraw.`);
      }
      await pauseBetweenActions(config.settings, signal);
    }

    try {
      loginData = await requestWithProxyRotation('refresh saldo', (activeClient) => activeClient.login());
      user = loginData?.user || user;
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Gagal memperbarui saldo setelah claim: ${error.message}`);
      return 'failed';
    }

    const minedBalance = Math.max(0, finiteNumber(user.mined_balance));
    const amount = Math.floor((minedBalance + Number.EPSILON) * 10_000) / 10_000;
    log.info(`Mined Balance terbaru: ${amount.toFixed(4)} ATF.`);
    if (amount < MIN_WITHDRAW_ATF) {
      log.info(`Skip: saldo di bawah minimum ${MIN_WITHDRAW_ATF} ATF.`);
      return 'skipped';
    }

    let maxCaptchaAttempts = config.settings.withdraw_captcha_max_attempts;
    let withdrawResponse = null;
    for (let attempt = 1; attempt <= maxCaptchaAttempts && !signal.aborted; attempt += 1) {
      let solved = null;
      try {
        log.info(`[Withdraw] Meminta CAPTCHA (${attempt}/${maxCaptchaAttempts}) untuk ${amount.toFixed(4)} ATF.`);
        const puzzle = await requestWithProxyRotation(
          'mengambil CAPTCHA withdraw',
          (activeClient) => activeClient.getWithdrawPuzzle(amount)
        );
        const challengeId = String(puzzle?.challenge_id || '').trim();
        const captchaImage = String(puzzle?.captcha_image || '').trim();
        if (puzzle?.status !== 'success' || !challengeId || !captchaImage) {
          throw new Error(puzzle?.message || 'Server tidak mengembalikan CAPTCHA withdrawal yang valid');
        }
        const puzzleRetry = withdrawRetryState(puzzle, maxCaptchaAttempts - attempt + 1);
        maxCaptchaAttempts = Math.min(maxCaptchaAttempts, (attempt - 1) + puzzleRetry.attemptsLeft);
        if (puzzleRetry.retryAfterSeconds > 0 || puzzleRetry.attemptsLeft <= 0) {
          const waitText = puzzleRetry.retryAfterSeconds > 0 ? ` Coba lagi dalam ${puzzleRetry.retryAfterSeconds}s.` : '';
          log.warn(`Withdraw dikunci server atau percobaan CAPTCHA sudah habis.${waitText}`);
          return 'failed';
        }
        solved = await solveImageCaptchaWith2Captcha({
          apiKey: twoCaptchaApiKey,
          image: captchaImage,
          timeoutMs: Math.min(240_000, Math.max(30_000, (Number.parseInt(puzzle.expires_in || '300', 10) - 20) * 1000)),
          signal,
          onProgress: (message) => log.info(`[2Captcha] ${message}`)
        });
        log.success('[2Captcha] Jawaban diterima; mengirim request withdraw.');
        await sleep(withdrawSubmitJitterMs(), signal);
        const withdrawRequestId = crypto.randomUUID();
        withdrawResponse = await requestWithProxyRotation(
          'submit withdraw',
          (activeClient) => activeClient.withdraw({
            amount,
            captchaId: challengeId,
            captchaAnswer: solved.text,
            requestId: withdrawRequestId
          })
        );
      } catch (error) {
        if (isAbortError(error) || error?.code === 'ABORTED') throw error;
        if (error instanceof TwoCaptchaError && attempt < maxCaptchaAttempts) {
          log.warn(`[2Captcha] ${error.message}; meminta CAPTCHA baru.`);
          await sleep(config.settings.retry_delay_seconds * 1000, signal);
          continue;
        }
        log.warn(`Withdraw/CAPTCHA gagal: ${error.message}`);
        return 'failed';
      }

      if (withdrawResponse?.status === 'success') break;
      if (isKycRequired(withdrawResponse)) {
        log.warn(`Withdraw ditahan untuk KYC: ${withdrawResponse?.message || 'Account verification required'}.`);
        return 'kyc';
      }

      const reason = String(withdrawResponse?.reason || withdrawResponse?.code || '').trim().toLowerCase();
      if (reason === 'withdraw_locked') {
        log.warn(`Withdraw dikunci server: ${withdrawResponse?.message || 'coba lagi nanti'}.`);
        return 'failed';
      }
      if (CAPTCHA_RETRY_REASONS.has(reason)) {
        if (solved?.taskId) {
          await reportIncorrectImageCaptcha({ apiKey: twoCaptchaApiKey, taskId: solved.taskId, signal });
        }
        const retryState = withdrawRetryState(withdrawResponse, maxCaptchaAttempts - attempt);
        maxCaptchaAttempts = Math.min(maxCaptchaAttempts, attempt + retryState.attemptsLeft);
        if (retryState.retryAfterSeconds > 0) {
          log.warn(`Withdraw dikunci sementara setelah CAPTCHA ditolak. Coba lagi dalam ${retryState.retryAfterSeconds}s.`);
          return 'failed';
        }
        if (retryState.attemptsLeft <= 0 || attempt >= maxCaptchaAttempts) {
          log.warn('Percobaan CAPTCHA withdrawal dari server sudah habis.');
          return 'failed';
        }
        log.warn(`Jawaban CAPTCHA ditolak (${reason || 'captcha_failed'}); meminta challenge baru.`);
        await sleep(config.settings.retry_delay_seconds * 1000, signal);
        continue;
      }
      log.warn(`Withdraw ditolak: ${withdrawResponse?.message || reason || 'respons tidak valid'}.`);
      return 'failed';
    }

    if (!withdrawResponse || withdrawResponse.status !== 'success') {
      log.warn(`Withdraw gagal setelah ${maxCaptchaAttempts} percobaan CAPTCHA.`);
      return 'failed';
    }

    let history = null;
    try {
      history = await requestWithProxyRotation(
        'membaca withdrawal history',
        (activeClient) => activeClient.getWithdrawHistory()
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`Request withdraw terkirim tetapi history gagal dibaca: ${error.message}`);
    }
    const classified = classifyWithdrawalStatus(withdrawResponse, history);
    const requested = finiteNumber(withdrawResponse.requested_amount, amount);
    const fee = finiteNumber(withdrawResponse.fee, WITHDRAW_FEE_ATF);
    const received = finiteNumber(withdrawResponse.send_amount, Math.max(0, requested - fee));
    if (classified.status === 'kyc') {
      log.warn(`Withdraw ${requested.toFixed(4)} ATF memerlukan KYC.`);
    } else if (classified.status === 'failed') {
      log.warn(`Withdraw ${requested.toFixed(4)} ATF berstatus gagal/rejected: ${classified.item?.error_message || '-'}.`);
    } else {
      log.success(`Withdraw ${requested.toFixed(4)} ATF berhasil disubmit | Fee ${fee.toFixed(4)} | Receive ${received.toFixed(4)} | Status ${classified.status.toUpperCase()}.`);
    }
    return classified.status;
  }));
}

async function withdrawEligibleAccounts() {
  const config = loadConfig(rootDirectory);
  setLogLevel(config.settings.log_level);
  dotenv.config({ path: path.join(rootDirectory, '.env'), override: true, quiet: true });
  const twoCaptchaApiKey = String(process.env.TWOCAPTCHA_API_KEY || '').trim();
  if (!twoCaptchaApiKey) throw new Error('Isi TWOCAPTCHA_API_KEY pada .env sebelum menjalankan opsi 5');

  const withdrawProxies = loadProxies(rootDirectory);
  const accounts = discoverSessionAccounts(rootDirectory, config.telegram, withdrawProxies);
  if (accounts.length === 0) {
    log.warn(`Tidak ada file *.session di ${path.resolve(rootDirectory, config.telegram.session_directory)}`);
    return;
  }
  if (!await confirmBatchWithdrawal(accounts.length)) {
    log.info('Withdraw massal dibatalkan.');
    return;
  }

  const credentials = loadCredentialsWithHint();
  const proxyHealth = new ProxyHealth({
    statePath: path.join(stateDirectory, 'proxy-health.json'),
    failureThreshold: config.settings.proxy_failure_threshold,
    cooldownMinutes: config.settings.proxy_cooldown_minutes
  });
  const proxyPool = new WithdrawProxyPool(withdrawProxies, {
    canUse: (proxy) => proxyHealth.canUse(proxy)
  });
  if (proxyPool.configuredCount > 0) {
    log.info(`Withdraw proxy pool: ${proxyPool.configuredCount} proxy unik tersedia; setiap proxy hanya boleh dipakai sekali selama sesi ini.`);
    if (proxyPool.configuredCount < accounts.length) {
      log.warn(`Jumlah proxy unik (${proxyPool.configuredCount}) lebih sedikit dari akun (${accounts.length}); akun atau retry setelah pool habis akan dilewati.`);
    }
  } else {
    log.warn('proxy.txt/proxies.txt kosong; withdraw berjalan direct dan tidak dapat melakukan rotasi proxy.');
  }
  const counts = { pending: 0, approved: 0, kyc: 0, failed: 0, skipped: 0 };

  for (let index = 0; index < accounts.length && !shutdownController.signal.aborted; index += 1) {
    const status = await withdrawAccount({
      account: accounts[index],
      index,
      total: accounts.length,
      config,
      credentials,
      proxyHealth,
      proxyPool,
      twoCaptchaApiKey,
      signal: shutdownController.signal
    });
    counts[status] = (counts[status] || 0) + 1;
    if (index < accounts.length - 1 && !shutdownController.signal.aborted) {
      const { min, max } = config.settings.delay_between_accounts_seconds;
      await randomDelay(min, max, shutdownController.signal);
    }
  }

  log.info(`Withdraw selesai: ${counts.pending} pending, ${counts.approved} approved, ${counts.kyc} KYC, ${counts.skipped} skip, ${counts.failed} gagal.`);
}

async function refreshDashboardStats({ accounts, config, credentials, taskDefinitions, signal }) {
  log.info(`[DashboardRefresh] Memulai refresh state ${accounts.length} akun secara paralel.`);
  let succeeded = 0;
  let failed = 0;

  await Promise.all(accounts.map(async (account, index) => {
    if (signal.aborted) return;
    await waitWhilePaused(signal);
    emitDashboardEvent(account, 'status', { status: 'fetching' });

    await runAccountExclusive(account, () => runWithLogContext({ accountFile: account.fileName }, async () => {
      log.info(`[DashboardRefresh] Fetching ${index + 1}/${accounts.length}: ${account.name}.`);
      try {
        const auth = await acquireFreshInitData({
          account,
          telegramConfig: config.telegram,
          credentials
        });
        const client = createAtfClient(auth, account, config, signal);
        const loginData = await client.login();
        const user = loginData?.user || {};
        let refSuccess = Math.max(0, Number.parseInt(user.ref_success || '0', 10) || 0);
        let refTotal = 0;
        try {
          const friends = await client.getFriends();
          if (friends?.status === 'success') {
            refSuccess = Math.max(0, Number.parseInt(friends.success ?? refSuccess, 10) || 0);
            refTotal = Math.max(0, Number.parseInt(friends.total || '0', 10) || 0);
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          log.warn(`[DashboardRefresh] Referral stats ${account.name} gagal: ${error.message}`);
        }

        emitDashboardSnapshot(account, user, {
          status: 'success',
          connection: proxyLabel(account.proxy),
          ref_success: refSuccess,
          ref_total: refTotal,
          next_task_at: nextRepeatableTaskEpoch(loginData, taskDefinitions)
        });
        succeeded += 1;
        log.success(`[DashboardRefresh] ${account.name} selesai; lanjut akun berikutnya.`);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failed += 1;
        emitDashboardEvent(account, 'status', { status: 'failed' });
        log.warn(`[DashboardRefresh] ${account.name} gagal: ${error.message}`);
      }
    }));
  }));

  if (!signal.aborted) {
    log.info(`[DashboardRefresh] Selesai: ${succeeded} akun berhasil, ${failed} gagal.`);
  }
}

async function waitUntil(targetTimeMs, signal) {
  while (!signal.aborted) {
    await waitWhilePaused(signal);
    const remaining = targetTimeMs - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, 30_000), signal);
  }
}

async function loginWorkerAccount({ account, config, credentials, proxyHealth, signal }) {
  if (account.proxy && !proxyHealth.canUse(account.proxy)) {
    throw new Error(`Proxy masih cooldown ${formatSeconds(proxyHealth.cooldownRemainingSeconds(account.proxy))}`);
  }
  const auth = await acquireFreshInitData({
    account,
    telegramConfig: config.telegram,
    credentials
  });
  const client = createAtfClient(auth, account, config, signal);
  try {
    const loginData = await client.login();
    proxyHealth.recordSuccess(account.proxy);
    return { client, loginData };
  } catch (error) {
    if (account.proxy && error instanceof ATFRequestError && error.status === 0) {
      proxyHealth.recordFailure(account.proxy);
    }
    throw error;
  }
}

function nextTaskWorkerEpoch(taskResult, refreshedLogin, taskDefinitions, retrySeconds) {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [
    Number.parseInt(taskResult?.nextClaimAt || '0', 10) || 0,
    nextRepeatableTaskEpoch(refreshedLogin, taskDefinitions, now)
  ].filter((epoch) => epoch > now);
  return candidates.length > 0 ? Math.min(...candidates) : now + retrySeconds;
}

async function runTaskAccountPass({ account, config, credentials, taskDefinitions, proxyHealth, signal }) {
  return runAccountExclusive(account, () => runWithLogContext({ accountFile: account.fileName }, async () => {
    await waitWhilePaused(signal);
    emitDashboardEvent(account, 'task', { next_task_at: Math.floor(Date.now() / 1000) });
    log.info('[TaskWorker] Waktu task tiba; membaca state task terbaru.');
    const { client, loginData } = await loginWorkerAccount({ account, config, credentials, proxyHealth, signal });
    const tracker = resultTracker();
    const taskResult = await processTasks({
      client,
      loginData,
      taskDefinitions,
      account,
      settings: config.settings,
      tracker,
      signal
    });

    let refreshedLogin = loginData;
    try {
      refreshedLogin = await client.login();
    } catch (error) {
      if (isAbortError(error)) throw error;
      log.warn(`[TaskWorker] Refresh state setelah task gagal: ${error.message}`);
    }

    const nextTaskAt = nextTaskWorkerEpoch(
      taskResult,
      refreshedLogin,
      taskDefinitions,
      config.settings.task_ready_retry_seconds
    );
    emitDashboardSnapshot(account, refreshedLogin?.user || loginData?.user || {}, {
      status: tracker.overall,
      next_task_at: nextTaskAt
    });
    emitDashboardEvent(account, 'task', {
      task_started: taskResult.started,
      task_claimed: taskResult.claimed,
      task_failed: taskResult.failed,
      next_task_at: nextTaskAt
    });
    const remainingMinutes = Math.max(0, Math.ceil((nextTaskAt - Date.now() / 1000) / 60));
    log.info(`[TaskWorker] Selesai; pengecekan akun berikutnya dalam ${remainingMinutes} menit.`);
    return nextTaskAt;
  }));
}

async function runTaskWorker({ account, initialNextTaskAt, config, credentials, taskDefinitions, proxyHealth, signal }) {
  if (config.settings.task_mode === 'off' || !taskDefinitions.some((task) => task.cooldown > 0)) return;
  let nextTaskAt = initialNextTaskAt || Math.floor(Date.now() / 1000);
  log.info(`[TaskWorker] ${account.name} aktif dengan jadwal independen.`);

  while (!signal.aborted) {
    await waitUntil(nextTaskAt * 1000, signal);
    if (signal.aborted) break;
    try {
      nextTaskAt = await runTaskAccountPass({
        account,
        config,
        credentials,
        taskDefinitions,
        proxyHealth,
        signal
      });
    } catch (error) {
      if (isAbortError(error)) break;
      nextTaskAt = Math.floor(Date.now() / 1000) + config.settings.task_ready_retry_seconds;
      runWithLogContext({ accountFile: account.fileName }, () => {
        log.warn(`[TaskWorker] Gagal membaca/memproses task: ${error.message}. Retry ${config.settings.task_ready_retry_seconds}s.`);
        emitDashboardEvent(account, 'task', { next_task_at: nextTaskAt });
      });
    }
  }
}

async function runMiningAccountPass({ account, config, credentials, proxyHealth, signal }) {
  return runAccountExclusive(account, () => runWithLogContext({ accountFile: account.fileName }, async () => {
    await waitWhilePaused(signal);
    log.info('[MiningWorker] Memulai siklus claim mining 3 jam.');
    const { client, loginData } = await loginWorkerAccount({ account, config, credentials, proxyHealth, signal });
    const tracker = resultTracker();
    let user = loginData?.user || {};
    const walletReady = hasVerifiedWallet(user);

    if (config.settings.auto_sync_mining_state) {
      try {
        const response = await client.syncMiningState();
        logBusinessResponse('Sync mining', response, tracker, 'sync_mining');
        if (response?.user && typeof response.user === 'object') user = { ...user, ...response.user };
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.warn(`[MiningWorker] Sync mining gagal: ${error.message}`);
        tracker.add('sync_mining', 'failed', error.message);
      }
      await pauseBetweenActions(config.settings, signal);
    }

    const claimable = Math.max(0, finiteNumber(user.claimable_now ?? user.mined_balance));
    if (config.settings.auto_claim && walletReady && claimable > 0) {
      try {
        const response = await client.claim(claimable);
        logBusinessResponse(`Claim mining ${claimable.toFixed(4)} ATF`, response, tracker, 'claim');
        if (response?.status === 'success') {
          user = { ...user, mined_balance: response.new_pool_balance ?? response.new_balance ?? user.mined_balance, claimable_now: 0 };
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.warn(`[MiningWorker] Claim mining gagal: ${error.message}`);
        tracker.add('claim', 'failed', error.message);
      }
      await pauseBetweenActions(config.settings, signal);
    }

    if (config.settings.auto_start_mining && walletReady) {
      const miningStartedAt = Math.max(0, Number.parseInt(user.last_mining_start || '0', 10) || 0);
      if (miningStartedAt === 0) {
        try {
          const challenge = await requestMathAnswer(client, signal);
          if (challenge) logBusinessResponse('Start mining', await client.startMine(challenge), tracker, 'start_mining');
        } catch (error) {
          if (isAbortError(error)) throw error;
          log.warn(`[MiningWorker] Start mining gagal: ${error.message}`);
          tracker.add('start_mining', 'failed', error.message);
        }
      }
    }

    emitDashboardSnapshot(account, user, { status: tracker.overall });
    log.info(`[MiningWorker] Siklus mining selesai dengan status ${tracker.overall}.`);
  }));
}

async function runDashboardRefreshLoop({ accounts = [], accountsProvider = null, config, credentials, taskDefinitions, signal }) {
  const intervalMs = config.settings.dashboard_refresh_interval_minutes * 60_000;
  log.info(`Auto-refresh dashboard aktif setiap ${config.settings.dashboard_refresh_interval_minutes} menit.`);
  while (!signal.aborted) {
    await waitUntil(Date.now() + intervalMs, signal);
    if (signal.aborted) break;
    if (dashboardRefreshPromise) continue;
    const refreshAccounts = typeof accountsProvider === 'function' ? accountsProvider() : accounts;
    dashboardRefreshPromise = refreshDashboardStats({ accounts: refreshAccounts, config, credentials, taskDefinitions, signal })
      .catch((error) => { if (!isAbortError(error)) log.error(`[DashboardRefresh] ${error.message}`); })
      .finally(() => { dashboardRefreshPromise = null; });
    await dashboardRefreshPromise;
  }
}

async function runAutomation() {
  let lastValidConfig = null;
  let walletStore = null;
  let walletStoreIdentity = '';
  let proxyHealth = null;
  let walletWorkers = null;
  let dashboardRefreshLoopStarted = false;
  const backgroundWorkers = [];
  const initialTaskSchedules = new Map();
  const initializedAccounts = new Set();
  const taskWorkerAccounts = new Set();
  const knownAccounts = new Map();

  while (!shutdownController.signal.aborted) {
    let config;
    try {
      config = loadConfig(rootDirectory);
      lastValidConfig = config;
    } catch (error) {
      if (!lastValidConfig) throw error;
      config = lastValidConfig;
      log.warn(`config.json baru tidak valid; tetap memakai konfigurasi terakhir: ${error.message}`);
    }
    setLogLevel(config.settings.log_level);

    dotenv.config({ path: path.join(rootDirectory, '.env'), override: true, quiet: true });
    const proxies = loadProxies(rootDirectory);
    const accounts = discoverSessionAccounts(rootDirectory, config.telegram, proxies);
    for (const account of accounts) knownAccounts.set(account.fileName, account);
    const requestedWalletPath = path.join(rootDirectory, config.telegram.wallet_accounts_file);
    const requestedWalletPassword = process.env.WALLET_KEYSTORE_PASSWORD || '';
    const requestedWalletIdentity = `${requestedWalletPath}\u0000${requestedWalletPassword}`;
    if (!walletStore) {
      walletStore = new WalletAccountStore(requestedWalletPath, requestedWalletPassword);
      walletStoreIdentity = requestedWalletIdentity;
    } else if (walletStoreIdentity !== requestedWalletIdentity) {
      log.warn('Lokasi/password wallet berubah saat bot aktif; konfigurasi lama dipakai sampai bot direstart agar worker tetap konsisten.');
    }
    if (!proxyHealth) {
      proxyHealth = new ProxyHealth({
        statePath: path.join(stateDirectory, 'proxy-health.json'),
        failureThreshold: config.settings.proxy_failure_threshold,
        cooldownMinutes: config.settings.proxy_cooldown_minutes
      });
    }
    if (!walletWorkers) {
      walletWorkers = new WalletWorkerPool({
        maxWorkers: config.settings.wallet_worker_concurrency,
        retryDelayMs: config.settings.wallet_busy_retry_seconds * 1000,
        signal: shutdownController.signal,
        runJob: async (job, attempt) => {
          log.info(`[WalletWorker] ${job.account.name}: percobaan worker #${attempt}.`);
          const result = await processAccount({
            account: job.account,
            index: job.index,
            total: job.total,
            config: job.config,
            credentials: job.credentials,
            taskDefinitions: job.taskDefinitions,
            proxyHealth,
            walletStore,
            walletBusyMaxRetries: 0,
            dashboardRunMode: 'wallet_worker',
            signal: shutdownController.signal
          });
          return { retry: result.deferredWallet === true, status: result.overall };
        },
        onEvent: (event) => {
          const accountName = event.job?.account?.name || event.job?.key || 'akun';
          if (event.type === 'started') {
            log.info(`[WalletWorker] ${accountName} mulai (aktif ${event.active}/${config.settings.wallet_worker_concurrency}, antre ${event.queued}).`);
          } else if (event.type === 'retry_wait') {
            log.warn(`[WalletWorker] ${accountName} masih busy/cached; retry lagi dalam ${config.settings.wallet_busy_retry_seconds}s.`);
          } else if (event.type === 'completed') {
            if (event.result?.status === 'success') {
              log.success(`[WalletWorker] ${accountName} selesai dan keluar dari worker.`);
            } else {
              log.warn(`[WalletWorker] ${accountName} berhenti dengan status ${event.result?.status || 'unknown'}; tidak di-retry karena bukan busy/cached.`);
            }
          } else if (event.type === 'failed') {
            log.error(`[WalletWorker] ${accountName} berhenti karena error: ${event.error?.message || 'unknown error'}`);
          }
        }
      });
      log.info(`Wallet worker pool aktif: maksimal ${config.settings.wallet_worker_concurrency} akun paralel, retry ${config.settings.wallet_busy_retry_seconds}s.`);
    }
    if (accounts.length === 0) {
      log.warn(`Tidak ada file *.session di ${path.resolve(rootDirectory, config.telegram.session_directory)}`);
      await sleep(config.settings.empty_account_retry_seconds * 1000, shutdownController.signal);
      continue;
    }

    const credentials = loadCredentialsWithHint();

    let taskDefinitions = [];
    if (config.settings.task_mode !== 'off') {
      fs.mkdirSync(cacheDirectory, { recursive: true });
      try {
        const loaded = await loadTaskDefinitions({
          sourceUrl: config.settings.task_source_url,
          timeoutMs: config.settings.request_timeout_seconds * 1000,
          cachePath: path.join(cacheDirectory, 'tasks.json'),
          signal: shutdownController.signal
        });
        taskDefinitions = loaded.tasks;
      } catch (error) {
        if (isAbortError(error)) break;
        log.warn(error.message);
      }
    }

    dashboardRefreshHandler = () => {
      if (dashboardRefreshPromise) {
        log.warn('[DashboardRefresh] Refresh statistik masih berjalan.');
        return;
      }
      dashboardRefreshPromise = refreshDashboardStats({
        accounts: [...accounts],
        config,
        credentials,
        taskDefinitions,
        signal: shutdownController.signal
      }).catch((error) => {
        if (!isAbortError(error)) log.error(`[DashboardRefresh] Error tak terduga: ${error.message}`);
      }).finally(() => {
        dashboardRefreshPromise = null;
      });
    };
    if (dashboardRefreshRequested) {
      dashboardRefreshRequested = false;
      dashboardRefreshHandler();
    }

    const accountsToInitialize = accounts.filter((account) => !initializedAccounts.has(account.fileName));
    const miningAccounts = accounts.filter((account) => initializedAccounts.has(account.fileName));
    if (miningAccounts.length > 0) {
      log.info(`Siklus ${config.settings.loop_interval_hours} jam: claim mining ${miningAccounts.length} akun lama secara paralel.`);
      await Promise.all(miningAccounts.map((account) => runMiningAccountPass({
        account,
        config,
        credentials,
        proxyHealth,
        signal: shutdownController.signal
      }).catch((error) => {
        if (!isAbortError(error)) {
          runWithLogContext({ accountFile: account.fileName }, () => log.warn(`[MiningWorker] ${error.message}`));
        }
      })));
    }
    if (accountsToInitialize.length === 0) {
      await countdownUntil(Date.now() + config.settings.loop_interval_hours * 3_600_000, shutdownController.signal);
      continue;
    }

    log.info(`Onboarding lengkap ${accountsToInitialize.length} akun baru secara berurutan; wallet wajib diperiksa sebelum akun ditandai aktif.`);
    const cycleResults = [];
    const newlyInitialized = [];
    for (let index = 0; index < accountsToInitialize.length && !shutdownController.signal.aborted; index += 1) {
      await waitWhilePaused(shutdownController.signal);
      const account = accountsToInitialize[index];
      const workerKey = account.fileName;
      if (walletWorkers.has(workerKey)) {
        log.info(`[WalletWorker] ${account.name} masih aktif/mengantre; dilewati oleh proses utama agar tidak duplikat.`);
        cycleResults.push('partial');
        continue;
      }
      try {
        const result = await processAccount({
          account,
          index,
          total: accountsToInitialize.length,
          config,
          credentials,
          taskDefinitions,
          proxyHealth,
          walletStore,
          walletBusyMaxRetries: Math.min(config.settings.wallet_busy_max_retries, 1),
          signal: shutdownController.signal
        });
        if (result.deferredWallet) {
          const enqueued = walletWorkers.enqueue({
            key: workerKey,
            account,
            index,
            total: accountsToInitialize.length,
            config,
            credentials,
            taskDefinitions
          });
          if (enqueued) {
            emitDashboardEvent(account, 'status', { status: 'worker', wallet: 'Retry worker' });
            log.warn(`[WalletWorker] ${account.name} dialihkan ke worker; proses akun utama lanjut (aktif ${walletWorkers.activeCount}/${config.settings.wallet_worker_concurrency}, antre ${walletWorkers.queuedCount}).`);
          }
          cycleResults.push('partial');
        } else {
          cycleResults.push(result.overall);
          initialTaskSchedules.set(account.fileName, result.nextTaskAt || 0);
        }
        const loginSucceeded = result.stages.some((stage) => stage.name === 'atf_login' && stage.status === 'success');
        const walletHandled = result.deferredWallet === true ||
          result.stages.some((stage) => stage.name === 'wallet' && stage.status === 'success');
        if (loginSucceeded && walletHandled) {
          initializedAccounts.add(account.fileName);
          newlyInitialized.push(account);
        } else if (loginSucceeded) {
          log.warn(`Onboarding ${account.name} belum ditandai selesai karena tahap wallet gagal; akan dicoba lagi pada pass berikutnya.`);
        }
      } catch (error) {
        if (isAbortError(error)) break;
        log.error(`Akun ${account.name} mengalami error tak terduga: ${error.message}`);
        cycleResults.push('failed');
      }

      if (index < accountsToInitialize.length - 1 && !shutdownController.signal.aborted) {
        const { min, max } = config.settings.delay_between_accounts_seconds;
        await randomDelay(min, max, shutdownController.signal);
      }
    }

    if (shutdownController.signal.aborted) break;
    const counts = cycleResults.reduce((result, status) => ({ ...result, [status]: (result[status] || 0) + 1 }), {});
    log.info(`Onboarding akun baru selesai: ${counts.success || 0} sukses, ${counts.partial || 0} parsial/worker, ${counts.failed || 0} gagal. Wallet worker: ${walletWorkers.activeCount} aktif, ${walletWorkers.queuedCount} antre.`);

    for (const account of newlyInitialized) {
      if (taskWorkerAccounts.has(account.fileName)) continue;
      taskWorkerAccounts.add(account.fileName);
      backgroundWorkers.push(runTaskWorker({
        account,
        initialNextTaskAt: initialTaskSchedules.get(account.fileName) || 0,
        config,
        credentials,
        taskDefinitions,
        proxyHealth,
        signal: shutdownController.signal
      }));
    }
    if (process.env.ATF_TEXTUAL_WORKER === '1' && !dashboardRefreshLoopStarted) {
      dashboardRefreshLoopStarted = true;
      backgroundWorkers.push(runDashboardRefreshLoop({
        accountsProvider: () => [...knownAccounts.values()],
        config,
        credentials,
        taskDefinitions,
        signal: shutdownController.signal
      }));
    }
    log.info(`${taskWorkerAccounts.size} task worker independen aktif; interval 3 jam tetap khusus claim mining.`);
    await countdownUntil(Date.now() + config.settings.loop_interval_hours * 3_600_000, shutdownController.signal);
  }

  dashboardRefreshHandler = null;
  if (dashboardRefreshPromise) await dashboardRefreshPromise;
  if (backgroundWorkers.length > 0) await Promise.allSettled(backgroundWorkers);
  if (walletWorkers) await walletWorkers.waitForIdle();
  log.info('Bot berhenti dengan aman.');
}

function emitStatsEvent(type, data = {}) {
  console.log(`[STATS_EVENT] ${JSON.stringify({ version: 1, type, ...data })}`);
}

function statsUserSnapshot(user, fallbackUsername, sourceStatus = 'login', withdrawal = {}) {
  const username = String(user?.username || fallbackUsername || '-').replace(/^@/, '');
  return {
    username: username ? `@${username}` : '-',
    wallet_address: String(user?.wallet_address || '-'),
    wallet_holding_atf: finiteNumber(user?.wallet_holding_atf),
    mined_balance: finiteNumber(user?.mined_balance),
    is_banned: Number(user?.is_banned) === 1 ? 1 : 0,
    risk_score: Math.max(0, finiteNumber(user?.risk_score)),
    has_qualified_dex_buy: Number(user?.has_qualified_dex_buy) === 1 ? 1 : 0,
    buyer_protection_revoked: Number(user?.buyer_protection_revoked) === 1 ? 1 : 0,
    nonbuyer_rule_label: String(user?.nonbuyer_rule_label || '-'),
    level_pending_withdraw_atf: Math.max(0, finiteNumber(user?.level_pending_withdraw_atf)),
    withdraw_status: String(withdrawal.status || 'none'),
    withdraw_amount: Math.max(0, finiteNumber(withdrawal.amount)),
    withdraw_masked_auto_fraud: withdrawal.maskedAutoFraud == null ? null : Boolean(withdrawal.maskedAutoFraud),
    source_status: String(sourceStatus || 'unknown')
  };
}

async function checkAccountStats({ account, index, total, config, credentials, signal }) {
  return runWithLogContext({ accountFile: account.fileName }, async () => {
    emitStatsEvent('account', {
      account: account.fileName,
      position: index + 1,
      total,
      status: 'loading'
    });
    try {
      const auth = await acquireFreshInitData({
        account,
        telegramConfig: config.telegram,
        credentials
      });
      const client = createAtfClient(auth, account, config, signal);
      const loginData = await client.login();
      let user = loginData?.user || {};
      let sourceStatus = 'login';
      const wallet = String(user.wallet_address || '').trim();

      if (/^-?\d+:[a-f0-9]{64}$/i.test(wallet)) {
        const walletResponse = await client.syncWalletStats(wallet);
        if (walletResponse?.user && typeof walletResponse.user === 'object') {
          user = { ...user, ...walletResponse.user };
        }
        if (walletResponse?.holding != null) user.wallet_holding_atf = walletResponse.holding;
        sourceStatus = walletResponse?.status || 'sync_wallet';
      } else {
        sourceStatus = wallet ? 'invalid_wallet' : 'wallet_not_connected';
      }

      let withdrawal = { status: 'none', amount: 0, maskedAutoFraud: null };
      try {
        const history = await client.getWithdrawHistory();
        if (history?.status === 'success') {
          withdrawal = summarizeWithdrawalHistory(history);
        } else {
          withdrawal = { status: 'unavailable', amount: 0, maskedAutoFraud: null };
          log.warn(`[StatsWorker] History withdraw ${account.name} tidak tersedia: ${history?.message || 'respons tidak valid'}.`);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        withdrawal = { status: 'unavailable', amount: 0, maskedAutoFraud: null };
        log.warn(`[StatsWorker] History withdraw ${account.name} gagal: ${error.message}`);
      }

      emitStatsEvent('account', {
        account: account.fileName,
        position: index + 1,
        total,
        status: 'success',
        ...statsUserSnapshot(user, auth.userInfo.username || account.name, sourceStatus, withdrawal)
      });
      log.success(`[StatsWorker] ${account.name} selesai (${sourceStatus}).`);
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      emitStatsEvent('account', {
        account: account.fileName,
        position: index + 1,
        total,
        status: 'failed',
        username: `@${account.name}`,
        source_status: 'error',
        error: safeTerminalText(error.message, 200)
      });
      log.warn(`[StatsWorker] ${account.name} gagal: ${error.message}`);
      return false;
    }
  });
}

async function checkStatsAccounts() {
  const signal = shutdownController.signal;
  dotenv.config({ path: path.join(rootDirectory, '.env'), override: true, quiet: true });
  const config = loadConfig(rootDirectory);
  setLogLevel(config.settings.log_level);
  const accounts = discoverSessionAccounts(rootDirectory, config.telegram, loadProxies(rootDirectory));
  const credentials = loadCredentialsWithHint();
  const concurrency = Math.min(5, config.settings.stats_worker_concurrency, accounts.length);

  emitStatsEvent('start', { total: accounts.length, concurrency });
  if (accounts.length === 0) {
    emitStatsEvent('done', { total: 0, success: 0, failed: 0 });
    return;
  }

  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (!signal.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= accounts.length) return;
      const ok = await checkAccountStats({
        account: accounts[index],
        index,
        total: accounts.length,
        config,
        credentials,
        signal
      });
      if (ok) succeeded += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  emitStatsEvent('done', { total: accounts.length, success: succeeded, failed });
}

function clearTerminal() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
}

function waitForEnterToMenu() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return Promise.resolve();
  process.stdout.write(chalk.gray('\nTekan Enter untuk kembali ke menu utama...'));
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = () => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Abaikan jika host terminal tidak mengekspos perubahan raw mode.
      }
      process.stdin.pause();
      resolve();
    };
    const onKeypress = (_text, key = {}) => {
      if (key.name === 'return' || key.name === 'enter' || (key.ctrl && key.name === 'c')) finish();
    };
    process.stdin.on('keypress', onKeypress);
  });
}

function configuredTurnstileProvider() {
  const arg = process.argv.find((value) => /^--solver=(multibot|local)$/i.test(value));
  const configured = arg?.split('=')[1] || process.env.TURNSTILE_SOLVER || 'multibot';
  return String(configured).toLowerCase() === 'local' ? 'local' : 'multibot';
}

async function chooseTurnstileProvider() {
  const fallback = configuredTurnstileProvider();
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return fallback;

  console.log(chalk.cyan('\nPilih solver Cloudflare Turnstile untuk opsi 2:'));
  console.log(`${chalk.blue('[1]')} MultiBot cloud`);
  console.log(`${chalk.green('[2]')} Solver lokal (${process.env.LOCAL_TURNSTILE_SOLVER_URL || 'http://127.0.0.1:8000'})`);
  console.log(`${chalk.gray('[0]')} Batal`);
  process.stdout.write(chalk.white('Tekan 0, 1, atau 2: '));

  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (provider) => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Host terminal tertentu tidak mengekspos perubahan raw mode.
      }
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(provider);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(null);
      if (text === '1') return finish('multibot');
      if (text === '2') return finish('local');
      if (text === '0') return finish(null);
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function confirmWalletReplacement({ username, accountId, currentAddress }) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Penggantian wallet memerlukan terminal interaktif agar setiap wallet external/unknown dapat dikonfirmasi');
  }

  console.log(chalk.yellow('\nWallet verified tanpa mnemonic lokal terdeteksi:'));
  console.log(`  Telegram : ${username ? `@${username.replace(/^@/, '')}` : '-'} (${accountId})`);
  console.log(`  Wallet   : ${currentAddress ? maskIdentifier(currentAddress, 10) : '(belum terhubung)'}`);
  console.log(chalk.red('  Wallet lama akan diganti pada akun ATF. Aset on-chain di wallet lama tidak ikut dipindahkan.'));
  process.stdout.write(chalk.white('Ganti dengan wallet baru? [y] Ya / [n] Skip / [q] Batalkan sisa: '));

  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (decision) => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Terminal tertentu tidak mengekspos perubahan raw mode.
      }
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(decision);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish('cancel');
      if (/^y$/i.test(text)) return finish('replace');
      if (/^n$/i.test(text) || key.name === 'return' || key.name === 'enter') return finish('skip');
      if (/^q$/i.test(text) || key.name === 'escape') return finish('cancel');
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function confirmBatchWithdrawal(accountCount) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Withdraw massal hanya dapat dijalankan dari terminal interaktif');
  }
  console.log(chalk.yellow(`\nBot akan memindai ${accountCount} akun secara berurutan.`));
  console.log(chalk.yellow(`Semua mined balance >= ${MIN_WITHDRAW_ATF} ATF akan di-withdraw; fee ${WITHDRAW_FEE_ATF} ATF per request.`));
  process.stdout.write(chalk.white('Lanjutkan withdraw massal? [y] Ya / [n] Batal: '));
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (confirmed) => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Terminal tertentu tidak mengekspos perubahan raw mode.
      }
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(confirmed);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(false);
      if (/^y$/i.test(text)) return finish(true);
      if (/^n$/i.test(text) || key.name === 'return' || key.name === 'enter' || key.name === 'escape') return finish(false);
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function chooseMode() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--dashboard')) return 'dashboard';
  if (args.has('--run')) return 'run';
  if (args.has('--register-referral')) return 'register-referral';
  if (args.has('--replace-wallets')) return 'replace-wallets';
  if (args.has('--withdraw')) return 'withdraw';
  if (args.has('--stats-dashboard')) return 'stats-dashboard';
  if (args.has('--stats-worker')) return 'stats-worker';
  if (args.has('--help')) return 'help';
  if (!process.stdin.isTTY) return 'run';

  const config = loadConfig(rootDirectory);
  console.log(chalk.cyan('\nPilih menu:'));
  console.log(`${chalk.green('[1]')} Jalankan BOT`);
  console.log(`${chalk.yellow('[2]')} Daftarkan akun dengan kode referral ${config.telegram.referral_code || '(belum diisi)'}`);
  console.log(`${chalk.red('[3]')} Ganti wallet TON ${chalk.gray('• membuat wallet baru untuk akun tanpa mnemonic tersimpan')}`);
  console.log(`${chalk.cyan('[4]')} Cek Stats akun`);
  console.log(`${chalk.green('[5]')} Withdraw ATF`);
  console.log(`${chalk.gray('[0]')} Keluar`);
  process.stdout.write(chalk.white('Tekan 0, 1, 2, 3, 4, atau 5: '));

  // Jangan memakai readline cooked untuk menu yang langsung membuka Textual.
  // Pada Windows/ConPTY, readline dapat meninggalkan state input sehingga UI
  // tampil tetapi event keyboard dan mouse tidak masuk. Pola raw-key + cleanup
  // ini sama dengan launcher dashboard Silvana.
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (mode) => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Host terminal tertentu tidak mengekspos perubahan raw mode.
      }
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(mode);
    };

    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish('exit');
      if (text === '1') return finish('dashboard');
      if (text === '2') return finish('register-referral');
      if (text === '3') return finish('replace-wallets');
      if (text === '4') return finish('stats-dashboard');
      if (text === '5') return finish('withdraw');
      if (text === '0') return finish('exit');
    };

    process.stdin.on('keypress', onKeypress);
  });
}

function findPythonExecutable() {
  const candidates = [];
  const configured = String(process.env.ATF_PYTHON || '').trim();
  if (configured) candidates.push({ command: configured, prefix: [] });

  if (process.platform === 'win32') {
    const localPrograms = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
      : '';
    if (localPrograms && fs.existsSync(localPrograms)) {
      try {
        const installed = fs.readdirSync(localPrograms, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
          .sort((a, b) => b.name.localeCompare(a.name))
          .map((entry) => path.join(localPrograms, entry.name, 'python.exe'));
        for (const command of installed) candidates.push({ command, prefix: [] });
      } catch {
        // Kandidat PATH di bawah tetap dicoba jika folder instalasi tidak dapat dibaca.
      }
    }
    candidates.push({ command: 'python', prefix: [] }, { command: 'py', prefix: ['-3'] });
  } else {
    candidates.push({ command: 'python3', prefix: [] }, { command: 'python', prefix: [] });
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function launchTextualDashboard() {
  const dashboardPath = path.join(rootDirectory, 'index-textual.py');
  if (!fs.existsSync(dashboardPath)) throw new Error(`Dashboard Textual tidak ditemukan: ${dashboardPath}`);
  const python = findPythonExecutable();
  if (!python) {
    throw new Error('Python 3 tidak ditemukan. Install Python 3, lalu jalankan: python -m pip install -r requirements-textual.txt');
  }

  // readline/menu Node dan Textual sama-sama memakai handle console yang sama.
  // Pastikan Node melepas raw/input mode sebelum Python mengaktifkan mouse
  // tracking milik Textual. Ini terutama penting pada Windows Terminal/ConPTY.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Textual tetap boleh dicoba jika host terminal tidak menyediakan raw mode.
    }
  }
  process.stdin.pause();

  const result = spawnSync(python.command, [...python.prefix, dashboardPath], {
    cwd: rootDirectory,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: 'inherit',
    windowsHide: false
  });
  if (result.error) throw new Error(`Dashboard Textual gagal dijalankan: ${result.error.message}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function launchStatsDashboard() {
  const dashboardPath = path.join(rootDirectory, 'stats-textual.py');
  if (!fs.existsSync(dashboardPath)) throw new Error(`Dashboard stats tidak ditemukan: ${dashboardPath}`);
  const python = findPythonExecutable();
  if (!python) {
    throw new Error('Python 3 tidak ditemukan. Install Python 3, lalu jalankan: python -m pip install -r requirements-textual.txt');
  }
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Dashboard tetap dicoba jika host terminal tidak mengekspos raw mode.
    }
  }
  process.stdin.pause();
  const result = spawnSync(python.command, [...python.prefix, dashboardPath], {
    cwd: rootDirectory,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: 'inherit',
    windowsHide: false
  });
  if (result.error) throw new Error(`Dashboard stats gagal dijalankan: ${result.error.message}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const directMode = [...args].some((arg) => [
    '--dashboard', '--run', '--register-referral', '--replace-wallets', '--withdraw', '--stats-dashboard', '--stats-worker', '--help'
  ].includes(arg));

  if (directMode || !process.stdin.isTTY) {
    printBanner();
    const mode = await chooseMode();
    if (mode === 'dashboard') return launchTextualDashboard();
    if (mode === 'run') {
      setupDashboardCommandInput();
      return runAutomation();
    }
    if (mode === 'register-referral') return registerReferralAccounts();
    if (mode === 'replace-wallets') return replaceMissingWalletAccounts();
    if (mode === 'withdraw') return withdrawEligibleAccounts();
    if (mode === 'stats-dashboard') return launchStatsDashboard();
    if (mode === 'stats-worker') return checkStatsAccounts();
    if (mode === 'help') {
      console.log('Usage: node index.js [--dashboard | --run | --register-referral | --replace-wallets | --withdraw | --stats-dashboard | --stats-worker | --help]');
    }
    return;
  }

  while (true) {
    clearTerminal();
    printBanner();
    const mode = await chooseMode();
    if (mode === 'exit') {
      clearTerminal();
      return;
    }

    clearTerminal();
    if (mode === 'dashboard') launchTextualDashboard();
    else if (mode === 'register-referral') await registerReferralAccounts();
    else if (mode === 'replace-wallets') await replaceMissingWalletAccounts();
    else if (mode === 'stats-dashboard') launchStatsDashboard();
    else if (mode === 'withdraw') await withdrawEligibleAccounts();

    await waitForEnterToMenu();
  }
}

main().catch((error) => {
  if (!isAbortError(error)) {
    log.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  }
});
