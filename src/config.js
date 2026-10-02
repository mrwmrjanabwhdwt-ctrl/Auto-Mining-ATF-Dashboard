import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './utils.js';

const DEFAULT_CONFIG = Object.freeze({
  telegram: {
    session_directory: 'session',
    account_overrides_file: 'account-overrides.json',
    wallet_accounts_file: 'wallets-accounts.json',
    bot_username: 'ATF_AIRDROP_bot',
    webapp_url: 'https://atfminers.asloni.online/miner/index.html',
    platform: 'android',
    start_param: '',
    referral_code: ''
  },
  settings: {
    api_base_url: 'https://atfminers.asloni.online/miner/index.php',
    task_source_url: 'https://atfminers.asloni.online/miner/index.html',
    allowed_hosts: ['atfminers.asloni.online'],
    auto_claim: true,
    auto_start_mining: true,
    auto_boost: true,
    auto_sync_mining_state: true,
    task_mode: 'claim_ready',
    auto_claim_referrals: true,
    auto_claim_team_wallet: true,
    wallet_busy_retry_seconds: 15,
    wallet_busy_max_retries: 1,
    wallet_worker_concurrency: 10,
    stats_worker_concurrency: 5,
    withdraw_captcha_max_attempts: 3,
    delay_between_accounts_seconds: { min: 3, max: 8 },
    delay_between_actions_ms: 750,
    task_ready_retry_seconds: 60,
    dashboard_refresh_interval_minutes: 10,
    loop_interval_hours: 3,
    empty_account_retry_seconds: 30,
    request_timeout_seconds: 20,
    max_attempts: 3,
    retry_delay_seconds: 2,
    max_retry_delay_seconds: 15,
    proxy_failure_threshold: 3,
    proxy_cooldown_minutes: 30,
    log_level: 'info'
  }
});

function mergeConfig(input) {
  return {
    telegram: { ...DEFAULT_CONFIG.telegram, ...(input?.telegram || {}) },
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...(input?.settings || {}),
      delay_between_accounts_seconds: {
        ...DEFAULT_CONFIG.settings.delay_between_accounts_seconds,
        ...(input?.settings?.delay_between_accounts_seconds || {})
      }
    }
  };
}

function requireBoolean(object, key) {
  if (typeof object[key] !== 'boolean') throw new Error(`${key} harus boolean`);
}

function requireNumber(object, key, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${key} harus ${integer ? 'integer' : 'angka'} antara ${min} dan ${max}`);
  }
}

export function validateHttpsUrl(rawUrl, allowedHosts, label = 'URL') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} tidak valid`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} wajib menggunakan HTTPS`);
  if (url.username || url.password) throw new Error(`${label} tidak boleh berisi kredensial`);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`${label} memakai host yang tidak diizinkan: ${url.hostname}`);
  }
  return url;
}

export function validateProxy(proxy) {
  if (proxy == null || String(proxy).trim() === '') return null;
  let url;
  try {
    url = new URL(String(proxy).trim());
  } catch {
    throw new Error('Format proxy tidak valid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Protocol proxy tidak didukung: ${url.protocol}`);
  }
  if (!url.hostname || !url.port) throw new Error('Proxy harus memiliki hostname dan port');
  return url.toString();
}

export function loadConfig(rootDirectory) {
  const configPath = path.join(rootDirectory, 'config.json');
  const raw = fs.existsSync(configPath) ? readJsonFile(configPath, 'config.json') : {};
  const config = mergeConfig(raw);
  const { telegram, settings } = config;

  if (!Array.isArray(settings.allowed_hosts) || settings.allowed_hosts.length === 0) {
    throw new Error('allowed_hosts harus berisi setidaknya satu hostname');
  }
  settings.allowed_hosts = [...new Set(settings.allowed_hosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean))];

  validateHttpsUrl(settings.api_base_url, settings.allowed_hosts, 'api_base_url');
  validateHttpsUrl(settings.task_source_url, settings.allowed_hosts, 'task_source_url');
  validateHttpsUrl(telegram.webapp_url, settings.allowed_hosts, 'telegram.webapp_url');

  if (!/^[A-Za-z0-9_]{5,64}$/.test(String(telegram.bot_username).replace(/^@/, ''))) {
    throw new Error('telegram.bot_username tidak valid');
  }
  telegram.bot_username = String(telegram.bot_username).replace(/^@/, '');
  if (!['android', 'ios', 'web', 'desktop'].includes(telegram.platform)) {
    throw new Error('telegram.platform tidak didukung');
  }
  telegram.referral_code = String(telegram.referral_code || '').trim();
  if (telegram.referral_code && !/^\d{4,20}$/.test(telegram.referral_code)) {
    throw new Error('telegram.referral_code harus berupa Telegram ID 4-20 digit');
  }
  if (typeof telegram.session_directory !== 'string' || telegram.session_directory.trim() === '') {
    throw new Error('telegram.session_directory wajib diisi');
  }
  if (typeof telegram.wallet_accounts_file !== 'string' || telegram.wallet_accounts_file.trim() === '' ||
      path.basename(telegram.wallet_accounts_file) !== telegram.wallet_accounts_file) {
    throw new Error('telegram.wallet_accounts_file harus berupa nama file lokal');
  }

  for (const key of [
    'auto_claim', 'auto_start_mining', 'auto_boost', 'auto_sync_mining_state',
    'auto_claim_referrals', 'auto_claim_team_wallet'
  ]) requireBoolean(settings, key);

  if (!['off', 'report', 'claim_ready'].includes(settings.task_mode)) {
    throw new Error('task_mode harus off, report, atau claim_ready');
  }
  requireNumber(settings, 'wallet_busy_retry_seconds', { min: 5, max: 3600, integer: true });
  requireNumber(settings, 'wallet_busy_max_retries', { min: 0, max: 10, integer: true });
  requireNumber(settings, 'wallet_worker_concurrency', { min: 1, max: 10, integer: true });
  requireNumber(settings, 'stats_worker_concurrency', { min: 1, max: 5, integer: true });
  requireNumber(settings, 'withdraw_captcha_max_attempts', { min: 1, max: 3, integer: true });
  requireNumber(settings.delay_between_accounts_seconds, 'min', { min: 0, max: 3600, integer: true });
  requireNumber(settings.delay_between_accounts_seconds, 'max', { min: 0, max: 3600, integer: true });
  if (settings.delay_between_accounts_seconds.max < settings.delay_between_accounts_seconds.min) {
    throw new Error('delay_between_accounts_seconds.max tidak boleh lebih kecil dari min');
  }
  requireNumber(settings, 'delay_between_actions_ms', { min: 0, max: 60_000, integer: true });
  requireNumber(settings, 'task_ready_retry_seconds', { min: 15, max: 3600, integer: true });
  requireNumber(settings, 'dashboard_refresh_interval_minutes', { min: 1, max: 1440 });
  requireNumber(settings, 'loop_interval_hours', { min: 1 / 60, max: 168 });
  requireNumber(settings, 'empty_account_retry_seconds', { min: 5, max: 3600, integer: true });
  requireNumber(settings, 'request_timeout_seconds', { min: 1, max: 120 });
  requireNumber(settings, 'max_attempts', { min: 1, max: 10, integer: true });
  requireNumber(settings, 'retry_delay_seconds', { min: 0, max: 60 });
  requireNumber(settings, 'max_retry_delay_seconds', { min: 1, max: 300 });
  requireNumber(settings, 'proxy_failure_threshold', { min: 1, max: 20, integer: true });
  requireNumber(settings, 'proxy_cooldown_minutes', { min: 1, max: 1440, integer: true });
  if (!['debug', 'info', 'warn', 'error'].includes(settings.log_level)) throw new Error('log_level tidak valid');

  return config;
}

function readUsefulLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function loadProxies(rootDirectory) {
  const primary = readUsefulLines(path.join(rootDirectory, 'proxy.txt'));
  const fallback = primary.length > 0 ? [] : readUsefulLines(path.join(rootDirectory, 'proxies.txt'));
  return (primary.length > 0 ? primary : fallback).map(validateProxy);
}

function loadAccountOverrides(rootDirectory, fileName) {
  const overridesPath = path.isAbsolute(fileName) ? fileName : path.join(rootDirectory, fileName);
  if (!fs.existsSync(overridesPath)) return {};
  const overrides = readJsonFile(overridesPath, path.basename(overridesPath));
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') {
    throw new Error('account-overrides.json harus berupa object');
  }
  return overrides;
}

export function discoverSessionAccounts(rootDirectory, telegramConfig, proxies = []) {
  const configuredDirectory = telegramConfig.session_directory;
  const sessionDirectory = path.resolve(rootDirectory, configuredDirectory);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const overrides = loadAccountOverrides(rootDirectory, telegramConfig.account_overrides_file);

  const files = fs.readdirSync(sessionDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.session'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return files.map((entry, index) => {
    const override = overrides[entry.name] || {};
    if (typeof override !== 'object' || Array.isArray(override)) {
      throw new Error(`Override ${entry.name} tidak valid`);
    }
    if (override.enabled != null && typeof override.enabled !== 'boolean') {
      throw new Error(`enabled untuk ${entry.name} harus boolean`);
    }
    const readyTaskIds = override.ready_task_ids ?? [];
    if (!Array.isArray(readyTaskIds) || readyTaskIds.some((id) => !/^[a-z0-9_:-]{1,80}$/i.test(String(id)))) {
      throw new Error(`ready_task_ids untuk ${entry.name} tidak valid`);
    }

    const proxyIsPinned = override.proxy != null;
    const proxy = proxyIsPinned
      ? validateProxy(override.proxy)
      : (proxies.length > 0 ? proxies[index % proxies.length] : null);

    return {
      name: path.basename(entry.name, path.extname(entry.name)),
      fileName: entry.name,
      sessionPath: path.join(sessionDirectory, entry.name),
      enabled: override.enabled ?? true,
      proxy,
      proxyIsPinned,
      readyTaskIds: [...new Set(readyTaskIds.map(String))]
    };
  }).filter((account) => account.enabled);
}

export { DEFAULT_CONFIG };
