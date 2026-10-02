import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import teleprotoPackage from 'teleproto';
import sessionPackage from 'teleproto/sessions/index.js';
import authKeyPackage from 'teleproto/crypto/AuthKey.js';
import { parseInitData } from './utils.js';

const { TelegramClient, Api } = teleprotoPackage;
const { MemorySession } = sessionPackage;
const { AuthKey } = authKeyPackage;

export function loadTelegramCredentials(environment = process.env) {
  const apiId = Number.parseInt(environment.TELEGRAM_API_ID || '', 10);
  const apiHash = String(environment.TELEGRAM_API_HASH || '').trim();
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('TELEGRAM_API_ID belum diisi atau tidak valid pada .env');
  }
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new Error('TELEGRAM_API_HASH belum diisi atau tidak valid pada .env');
  }
  return { apiId, apiHash };
}

export function inspectTelethonSession(sessionPath) {
  const stat = fs.statSync(sessionPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error('File session tidak ditemukan atau bukan file biasa');

  const header = Buffer.alloc(16);
  const descriptor = fs.openSync(sessionPath, 'r');
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString('ascii') !== 'SQLite format 3\0') {
    throw new Error('File bukan SQLite session Telethon');
  }

  const database = new DatabaseSync(sessionPath, { readOnly: true });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
    if (!table) throw new Error('Tabel sessions tidak ditemukan');
    const rows = database.prepare('SELECT dc_id, server_address, port, auth_key, takeout_id FROM sessions').all();
    if (rows.length !== 1) throw new Error(`Session harus memiliki tepat satu koneksi DC, ditemukan ${rows.length}`);
    const row = rows[0];
    const authKey = Buffer.from(row.auth_key || []);
    if (!Number.isInteger(row.dc_id) || row.dc_id <= 0 || !row.server_address || !Number.isInteger(row.port) || authKey.length !== 256) {
      throw new Error('Metadata atau auth key session tidak valid');
    }
    return {
      dcId: row.dc_id,
      serverAddress: String(row.server_address),
      port: row.port,
      authKey,
      takeoutId: row.takeout_id ?? null
    };
  } finally {
    database.close();
  }
}

async function createMemorySession(metadata) {
  const memorySession = new MemorySession();
  memorySession.setDC(metadata.dcId, metadata.serverAddress, metadata.port);
  const authKey = new AuthKey();
  await authKey.setKey(metadata.authKey);
  memorySession.authKey = authKey;
  return memorySession;
}

export function extractInitDataFromWebViewUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Telegram mengembalikan URL WebView yang tidak valid');
  }

  // Telegram may put WebApp parameters in either the query string or the
  // fragment, depending on the client/API layer that generated the URL.
  const queryInitData = url.searchParams.get('tgWebAppData');
  const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const fragmentInitData = fragmentParams.get('tgWebAppData');
  const initData = queryInitData || fragmentInitData;

  if (!initData) throw new Error('tgWebAppData tidak ditemukan pada URL WebView Telegram');
  return initData;
}

export async function acquireFreshInitData({ account, telegramConfig, credentials, referral = null }) {
  const metadata = inspectTelethonSession(account.sessionPath);
  const session = await createMemorySession(metadata);
  const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connectionRetries: 3,
    requestRetries: 2,
    retryDelay: 1000,
    autoReconnect: false,
    timeout: 10
  });

  try {
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      throw new Error('Session Telegram sudah tidak aktif; login ulang akun tersebut');
    }

    const me = await client.getMe();
    const botUsername = telegramConfig.bot_username.replace(/^@/, '');
    const bot = await client.getEntity(botUsername);
    if (referral?.code && String(me.id) === String(referral.code)) {
      throw new Error('Akun tidak boleh memakai Telegram ID-nya sendiri sebagai referral');
    }
    if (referral?.startBot) {
      await client.invoke(new Api.messages.StartBot({
        bot,
        peer: bot,
        startParam: String(referral.code)
      }));
      if (typeof referral.onBotStarted === 'function') referral.onBotStarted();
    }

    const launchStartParam = referral?.code || telegramConfig.start_param;
    const params = {
      peer: bot,
      bot,
      platform: telegramConfig.platform,
      fromBotMenu: true,
      url: telegramConfig.webapp_url
    };
    if (launchStartParam) params.startParam = launchStartParam;

    const result = await client.invoke(new Api.messages.RequestWebView(params));
    if (!result?.url) throw new Error('Telegram tidak memberikan URL WebView');
    const initData = extractInitDataFromWebViewUrl(result.url);
    const userInfo = parseInitData(initData, { maxAgeSeconds: 300 });

    if (String(me.id) !== userInfo.id) {
      throw new Error('Telegram ID pada initData tidak cocok dengan pemilik session');
    }
    return { initData, userInfo, referralCode: referral?.code || '' };
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Connection cleanup must not hide the original error.
    }
  }
}
