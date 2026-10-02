import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import chalk from 'chalk';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
let activeLogLevel = LEVELS.info;
const logContext = new AsyncLocalStorage();

export function runWithLogContext(context, callback) {
  return logContext.run(context && typeof context === 'object' ? context : {}, callback);
}

function contextualMessage(message) {
  const accountFile = String(logContext.getStore()?.accountFile || '').trim();
  const safeAccountFile = /^[A-Za-z0-9_. -]{1,160}\.session$/i.test(accountFile) ? accountFile : '';
  const prefix = process.env.ATF_TEXTUAL_WORKER === '1' && safeAccountFile
    ? `[ACCOUNT:${safeAccountFile}] `
    : '';
  return `${prefix}${message}`;
}

export function setLogLevel(level = 'info') {
  const normalized = String(level).toLowerCase();
  if (!(normalized in LEVELS)) {
    throw new Error(`log_level tidak valid: ${level}`);
  }
  activeLogLevel = LEVELS[normalized];
}

function shouldLog(level) {
  return LEVELS[level] >= activeLogLevel;
}

export function redactSensitive(value) {
  let text = value instanceof Error ? value.message : String(value ?? '');
  text = text
    .replace(/(query_id|user|auth_date|hash|signature)=[^&\s]+/gi, '$1=<REDACTED>')
    .replace(/(X-(?:Telegram-Init-Data|ATF-TMA-Session)\s*[:=]\s*)[^\s,]+/gi, '$1<REDACTED>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1<REDACTED>@')
    .replace(/((?:api[_-]?hash|session[_-]?token|initData)\s*[:=]\s*)[^\s,}]+/gi, '$1<REDACTED>');
  return text;
}

export const log = {
  debug(message) {
    if (shouldLog('debug')) console.log(`${chalk.gray('[DEBUG]')} ${redactSensitive(contextualMessage(message))}`);
  },
  info(message) {
    if (shouldLog('info')) console.log(`${chalk.blue('[INFO]')} ${redactSensitive(contextualMessage(message))}`);
  },
  success(message) {
    if (shouldLog('info')) console.log(`${chalk.green('[SUCCESS]')} ${redactSensitive(contextualMessage(message))}`);
  },
  warn(message) {
    if (shouldLog('warn')) console.log(`${chalk.yellow('[WARN]')} ${redactSensitive(contextualMessage(message))}`);
  },
  error(message) {
    if (shouldLog('error')) console.error(`${chalk.red('[ERROR]')} ${redactSensitive(contextualMessage(message))}`);
  },
  account(index, total, name) {
    if (!shouldLog('info')) return;
    console.log(`\n${chalk.cyan.bold('========================================')}`);
    console.log(`${chalk.magenta.bold(`[AKUN ${index}/${total}]`)} ${chalk.bold.white(redactSensitive(name))}`);
    console.log(chalk.cyan.bold('========================================'));
  },
  task(taskName, status) {
    if (shouldLog('info')) console.log(`  ${chalk.gray('•')} ${redactSensitive(taskName)}: ${redactSensitive(status)}`);
  }
};

export function sleep(ms, signal) {
  const duration = Math.max(0, Number(ms) || 0);
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, duration);

    function onAbort() {
      clearTimeout(timer);
      reject(createAbortError());
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAbortError() {
  const error = new Error('Operasi dihentikan');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
}

export function solveSimpleMathQuestion(question) {
  if (typeof question !== 'string' || question.trim() === '' || question.length > 120) return null;

  const normalized = question
    .replace(/[−–—]/g, '-')
    .replace(/[×✕·]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\bmultiplied\s+by\b|\btimes\b|\bdikali\b/gi, '*')
    .replace(/\bdivided\s+by\b|\bdibagi\b/gi, '/')
    .replace(/\bplus\b|\bditambah\b/gi, '+')
    .replace(/\bminus\b|\bdikurangi\b/gi, '-');
  const expressionPattern = /(-?\d{1,4})\s*([+*/xX-])\s*(-?\d{1,4})/g;
  const matches = [...normalized.matchAll(expressionPattern)];
  if (matches.length !== 1) return null;

  const match = matches[0];
  const before = normalized.slice(0, match.index);
  const after = normalized.slice(match.index + match[0].length);
  if (/-?\d+\s*[+*/xX-]\s*$/.test(before) || /^\s*[+*/xX-]\s*-?\d+/.test(after)) return null;

  const left = Number.parseInt(match[1], 10);
  const right = Number.parseInt(match[3], 10);
  let answer;
  switch (match[2].toLowerCase()) {
    case '+': answer = left + right; break;
    case '-': answer = left - right; break;
    case '*':
    case 'x': answer = left * right; break;
    case '/':
      if (right === 0 || left % right !== 0) return null;
      answer = left / right;
      break;
    default: return null;
  }

  return Number.isInteger(answer) && Math.abs(answer) <= 9999 ? answer : null;
}

export async function randomDelay(minSeconds, maxSeconds, signal) {
  const min = Number(minSeconds);
  const max = Number(maxSeconds);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new Error(`Rentang delay tidak valid: min=${minSeconds}, max=${maxSeconds}`);
  }
  const delaySeconds = Math.floor(Math.random() * (max - min + 1)) + min;
  log.info(`Menunggu jeda ${delaySeconds}s sebelum akun berikutnya...`);
  await sleep(delaySeconds * 1000, signal);
}

export function parseInitData(initData, { maxAgeSeconds = 0, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof initData !== 'string' || initData.trim() === '') {
    throw new Error('Telegram initData kosong');
  }

  const params = new URLSearchParams(initData.trim());
  const userText = params.get('user');
  const authDate = Number.parseInt(params.get('auth_date') || '0', 10);
  const hash = params.get('hash') || '';

  if (!userText || !authDate || !hash) {
    throw new Error('Telegram initData tidak lengkap');
  }
  if (maxAgeSeconds > 0 && nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('Telegram initData sudah kedaluwarsa');
  }
  if (authDate > nowSeconds + 60) {
    throw new Error('auth_date Telegram berada di masa depan');
  }

  let user;
  try {
    // URLSearchParams sudah melakukan percent-decoding. Jangan decode dua kali.
    user = JSON.parse(userText);
  } catch {
    throw new Error('Data user Telegram tidak valid');
  }

  const id = String(user?.id ?? '');
  if (!/^\d+$/.test(id) || id === '0') {
    throw new Error('Telegram user ID tidak valid');
  }

  return {
    id,
    firstName: String(user.first_name || 'User'),
    username: user.username ? String(user.username).replace(/^@/, '') : '',
    authDate,
    queryId: params.get('query_id') || ''
  };
}

export function maskIdentifier(value, visibleEnd = 4) {
  const text = String(value ?? '');
  if (text.length <= visibleEnd) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.min(8, text.length - visibleEnd))}${text.slice(-visibleEnd)}`;
}

export function readJsonFile(filePath, label = path.basename(filePath)) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Tidak dapat membaca ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} bukan JSON valid: ${error.message}`);
  }
}

export function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function getOrCreateDeviceId(stateDirectory, accountId) {
  const statePath = path.join(stateDirectory, 'device-ids.json');
  const accountKey = crypto.createHash('sha256').update(String(accountId)).digest('hex');
  let state = { version: 1, devices: {} };

  if (fs.existsSync(statePath)) {
    try {
      const parsed = readJsonFile(statePath, 'device state');
      if (parsed && parsed.version === 1 && parsed.devices && typeof parsed.devices === 'object') {
        state = parsed;
      }
    } catch (error) {
      log.warn(`Device state diabaikan: ${error.message}`);
    }
  }

  if (!state.devices[accountKey]) {
    state.devices[accountKey] = `dev-${crypto.randomUUID()}`;
    writeJsonAtomic(statePath, state);
  }
  return state.devices[accountKey];
}

export function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hours).padStart(2, '0')}j ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

export function printBanner() {
  console.clear();
  console.log(chalk.cyan(`
  █████╗ ████████╗███████╗    ██████╗  ██████╗ ████████╗
 ██╔══██╗╚══██╔══╝██╔════╝    ██╔══██╗██╔═══██╗╚══██╔══╝
 ███████║   ██║   █████╗      ██████╔╝██║   ██║   ██║
 ██╔══██║   ██║   ██╔══╝      ██╔══██╗██║   ██║   ██║
 ██║  ██║   ██║   ██║         ██████╔╝╚██████╔╝   ██║
 ╚═╝  ╚═╝   ╚═╝   ╚═╝         ╚═════╝  ╚═════╝    ╚═╝
`));
  console.log(chalk.bold.yellow('   >>> ATF Session-Based Automation Bot v2 <<<'));
  console.log(chalk.gray('   Fresh Telegram WebApp auth | Sequential accounts | Safe retries'));
  console.log(chalk.cyan('------------------------------------------------------------\n'));
}
