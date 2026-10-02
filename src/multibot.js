import { sleep } from './utils.js';

const MULTIBOT_SUBMIT_URL = 'https://api.multibot.cloud/in.php';
const MULTIBOT_RESULT_URL = 'https://api.multibot.cloud/res.php';
const NOT_READY_RESPONSES = new Set(['CAPCHA_NOT_READY', 'CAPTCHA_NOT_READY']);

export class MultiBotError extends Error {
  constructor(message, code = 'MULTIBOT_ERROR') {
    super(message);
    this.name = 'MultiBotError';
    this.code = code;
  }
}

function cleanValue(value, maxLength = 4096) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function parseMultiBotResponse(rawResponse) {
  const text = cleanValue(rawResponse, 20_000);
  if (!text) return { status: 0, request: 'EMPTY_RESPONSE' };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        status: Number(parsed.status) === 1 ? 1 : 0,
        request: cleanValue(parsed.request ?? parsed.error_text ?? parsed.message, 16_384)
      };
    }
  } catch {
    // Classic API may return plain text even when json=1 is requested.
  }

  if (text.startsWith('OK|')) return { status: 1, request: cleanValue(text.slice(3), 16_384) };
  return { status: 0, request: text };
}

export function formatMultiBotProxy(rawProxy) {
  if (!rawProxy) return '';
  let proxy;
  try {
    proxy = new URL(String(rawProxy));
  } catch {
    throw new MultiBotError('Proxy akun tidak valid untuk MultiBot', 'MULTIBOT_PROXY_INVALID');
  }
  if (!proxy.hostname || !proxy.port) {
    throw new MultiBotError('Proxy akun wajib memiliki host dan port', 'MULTIBOT_PROXY_INVALID');
  }
  const username = decodeURIComponent(proxy.username || '');
  const password = decodeURIComponent(proxy.password || '');
  const credentials = username ? `${username}:${password}@` : '';
  return `${credentials}${proxy.hostname}:${proxy.port}`;
}

async function fetchMultiBot(http, url, options, signal, requestTimeoutMs) {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await http(url, { ...options, signal: requestSignal });
    const text = await response.text();
    if (!response.ok) {
      throw new MultiBotError(`MultiBot mengembalikan HTTP ${response.status}`, 'MULTIBOT_HTTP_ERROR');
    }
    return parseMultiBotResponse(text);
  } catch (error) {
    if (error instanceof MultiBotError) throw error;
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError') {
      throw new MultiBotError('Request MultiBot melewati batas waktu', 'MULTIBOT_REQUEST_TIMEOUT');
    }
    throw new MultiBotError(`Koneksi MultiBot gagal: ${cleanValue(error?.message || 'network error', 240)}`, 'MULTIBOT_NETWORK_ERROR');
  }
}

export async function solveTurnstileWithMultiBot({
  apiKey,
  pageUrl,
  siteKey,
  proxy = '',
  signal,
  timeoutMs = 180_000,
  pollIntervalMs = 5_000,
  requestTimeoutMs = 20_000,
  http = globalThis.fetch,
  sleepFn = sleep,
  onProgress = () => {}
}) {
  const normalizedApiKey = cleanValue(apiKey, 512);
  const normalizedPageUrl = cleanValue(pageUrl, 2048);
  const normalizedSiteKey = cleanValue(siteKey, 512);
  if (!normalizedApiKey) throw new MultiBotError('MULTIBOT_API_KEY belum diisi di .env', 'MULTIBOT_API_KEY_MISSING');
  if (!normalizedPageUrl || !normalizedSiteKey) {
    throw new MultiBotError('pageurl atau sitekey Turnstile tidak tersedia', 'MULTIBOT_BAD_CAPTCHA_DATA');
  }
  if (typeof http !== 'function') throw new MultiBotError('HTTP client MultiBot tidak tersedia');
  const reportProgress = (message) => {
    try {
      onProgress(String(message));
    } catch {
      // Logging must never interrupt the captcha flow.
    }
  };

  const form = new FormData();
  form.append('key', normalizedApiKey);
  form.append('method', 'turnstile');
  form.append('pageurl', normalizedPageUrl);
  form.append('sitekey', normalizedSiteKey);
  form.append('json', '1');
  const normalizedProxy = formatMultiBotProxy(proxy);
  if (normalizedProxy) form.append('proxy', normalizedProxy);

  reportProgress('Mengirim task Turnstile ke API MultiBot...');
  const submitted = await fetchMultiBot(http, MULTIBOT_SUBMIT_URL, {
    method: 'POST',
    body: form,
    headers: { Accept: 'application/json, text/plain, */*' }
  }, signal, requestTimeoutMs);
  if (submitted.status !== 1 || !submitted.request) {
    throw new MultiBotError(`MultiBot menolak task: ${submitted.request || 'respons kosong'}`, 'MULTIBOT_SUBMIT_FAILED');
  }
  const taskId = submitted.request;
  const startedAt = Date.now();
  let pollAttempt = 0;
  reportProgress(`Task diterima dengan ID ${taskId}; mulai menunggu hasil (timeout ${Math.ceil(timeoutMs / 1000)} detik).`);

  while (Date.now() - startedAt < timeoutMs) {
    await sleepFn(pollIntervalMs, signal);
    pollAttempt += 1;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const remainingSeconds = Math.max(0, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000));
    reportProgress(`Polling #${pollAttempt}: menunggu token (${elapsedSeconds}s berjalan, ${remainingSeconds}s tersisa)...`);
    const resultUrl = new URL(MULTIBOT_RESULT_URL);
    resultUrl.searchParams.set('key', normalizedApiKey);
    resultUrl.searchParams.set('id', taskId);
    resultUrl.searchParams.set('json', '1');
    const result = await fetchMultiBot(http, resultUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain, */*' }
    }, signal, requestTimeoutMs);
    if (result.status === 1 && result.request) {
      reportProgress(`Token diterima pada polling #${pollAttempt} setelah ${elapsedSeconds}s.`);
      return result.request;
    }
    if (NOT_READY_RESPONSES.has(result.request)) {
      reportProgress(`Polling #${pollAttempt}: token belum siap; mencoba lagi dalam ${Math.ceil(pollIntervalMs / 1000)} detik.`);
      continue;
    }
    throw new MultiBotError(`MultiBot gagal menyelesaikan Turnstile: ${result.request || 'respons kosong'}`, 'MULTIBOT_SOLVE_FAILED');
  }

  throw new MultiBotError(`MultiBot belum menghasilkan token sebelum batas waktu ${Math.ceil(timeoutMs / 1000)} detik`, 'MULTIBOT_SOLVE_TIMEOUT');
}
