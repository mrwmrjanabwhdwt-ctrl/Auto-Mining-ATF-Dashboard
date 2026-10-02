import { sleep } from './utils.js';

export class LocalTurnstileError extends Error {
  constructor(message, code = 'LOCAL_TURNSTILE_ERROR') {
    super(message);
    this.name = 'LocalTurnstileError';
    this.code = code;
  }
}

function cleanValue(value, maxLength = 4096) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeLocalSolverUrl(rawUrl = 'http://127.0.0.1:8000') {
  let url;
  try {
    url = new URL(String(rawUrl || 'http://127.0.0.1:8000'));
  } catch {
    throw new LocalTurnstileError('URL solver lokal tidak valid', 'LOCAL_SOLVER_URL_INVALID');
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'http:' || !isLoopback || url.username || url.password || url.search || url.hash) {
    throw new LocalTurnstileError(
      'LOCAL_TURNSTILE_SOLVER_URL wajib berupa HTTP loopback, contoh http://127.0.0.1:8000',
      'LOCAL_SOLVER_URL_UNSAFE'
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

async function requestJson(http, url, options, signal, requestTimeoutMs) {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await http(url, { ...options, signal: requestSignal });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw new LocalTurnstileError('Solver lokal mengembalikan respons non-JSON', 'LOCAL_SOLVER_INVALID_RESPONSE');
    }
    return { statusCode: Number(response.status) || 0, data };
  } catch (error) {
    if (error instanceof LocalTurnstileError) throw error;
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError') {
      throw new LocalTurnstileError('Request ke solver lokal melewati batas waktu', 'LOCAL_SOLVER_REQUEST_TIMEOUT');
    }
    throw new LocalTurnstileError(
      `Server solver lokal tidak dapat dihubungi: ${cleanValue(error?.message || 'connection refused', 180)}`,
      'LOCAL_SOLVER_OFFLINE'
    );
  }
}

export async function solveTurnstileLocally({
  baseUrl = 'http://127.0.0.1:8000',
  pageUrl,
  siteKey,
  action = '',
  cdata = '',
  signal,
  timeoutMs = 90_000,
  pollIntervalMs = 1_000,
  requestTimeoutMs = 10_000,
  http = globalThis.fetch,
  sleepFn = sleep,
  onProgress = () => {}
}) {
  const solverUrl = normalizeLocalSolverUrl(baseUrl);
  const normalizedPageUrl = cleanValue(pageUrl, 2048);
  const normalizedSiteKey = cleanValue(siteKey, 512);
  if (!normalizedPageUrl || !normalizedSiteKey) {
    throw new LocalTurnstileError('pageurl atau sitekey Turnstile tidak tersedia', 'LOCAL_SOLVER_BAD_CAPTCHA_DATA');
  }
  if (typeof http !== 'function') throw new LocalTurnstileError('HTTP client solver lokal tidak tersedia');
  const reportProgress = (message) => {
    try {
      onProgress(String(message));
    } catch {
      // Logging must never interrupt the solver flow.
    }
  };

  const submitUrl = new URL(`${solverUrl.toString().replace(/\/$/, '')}/turnstile`);
  submitUrl.searchParams.set('url', normalizedPageUrl);
  submitUrl.searchParams.set('sitekey', normalizedSiteKey);
  if (action) submitUrl.searchParams.set('action', cleanValue(action, 256));
  if (cdata) submitUrl.searchParams.set('cdata', cleanValue(cdata, 2048));

  reportProgress(`Mengirim task ke ${solverUrl.origin}...`);
  const submitted = await requestJson(http, submitUrl.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' }
  }, signal, requestTimeoutMs);
  const taskId = cleanValue(submitted.data?.task_id, 256);
  if (![200, 202].includes(submitted.statusCode) || submitted.data?.status !== 'accepted' || !taskId) {
    const message = cleanValue(submitted.data?.detail?.error ?? submitted.data?.error ?? submitted.data?.message, 240);
    throw new LocalTurnstileError(`Solver lokal menolak task: ${message || `HTTP ${submitted.statusCode}`}`, 'LOCAL_SOLVER_SUBMIT_FAILED');
  }

  const startedAt = Date.now();
  let pollAttempt = 0;
  reportProgress(`Task diterima dengan ID ${taskId}; timeout ${Math.ceil(timeoutMs / 1000)} detik.`);
  while (Date.now() - startedAt < timeoutMs) {
    await sleepFn(pollIntervalMs, signal);
    pollAttempt += 1;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const remainingSeconds = Math.max(0, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000));
    reportProgress(`Polling #${pollAttempt}: ${elapsedSeconds}s berjalan, ${remainingSeconds}s tersisa...`);

    const resultUrl = new URL(`${solverUrl.toString().replace(/\/$/, '')}/result`);
    resultUrl.searchParams.set('id', taskId);
    const result = await requestJson(http, resultUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }, signal, requestTimeoutMs);
    const status = cleanValue(result.data?.status, 40).toLowerCase();
    if (result.statusCode === 202 || status === 'process') continue;
    if (result.statusCode === 200 && status === 'success') {
      const token = cleanValue(result.data?.value, 16_384);
      if (!token) throw new LocalTurnstileError('Solver lokal sukses tanpa token', 'LOCAL_SOLVER_EMPTY_TOKEN');
      reportProgress(`Token diterima pada polling #${pollAttempt} setelah ${elapsedSeconds}s.`);
      return token;
    }
    const message = cleanValue(result.data?.message ?? result.data?.detail?.error ?? result.data?.error ?? result.data?.value, 300);
    throw new LocalTurnstileError(`Solver lokal gagal: ${message || `HTTP ${result.statusCode}`}`, 'LOCAL_SOLVER_FAILED');
  }

  throw new LocalTurnstileError(
    `Solver lokal belum menghasilkan token sebelum batas waktu ${Math.ceil(timeoutMs / 1000)} detik`,
    'LOCAL_SOLVER_TIMEOUT'
  );
}
