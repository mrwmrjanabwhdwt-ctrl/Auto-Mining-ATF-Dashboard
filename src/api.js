import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log, sleep, createAbortError } from './utils.js';

const ALLOWED_ACTIONS = new Set([
  'login', 'claim', 'get_math_challenge', 'start_mine', 'activate_boost', 'start_task', 'claim_task',
  'get_friends', 'claim_referrals', 'claim_team_wallet', 'sync_mining_state', 'get_wallet_proof_payload', 'sync_wallet',
  'get_withdraw_puzzle', 'withdraw', 'get_withdraw_history', 'captcha_status', 'verify_entry_captcha'
]);

export class ATFRequestError extends Error {
  constructor(message, { action, status = 0, retryable = false, code = '', responseData = null } = {}) {
    super(message);
    this.name = 'ATFRequestError';
    this.action = action;
    this.status = status;
    this.retryable = retryable;
    this.code = code;
    this.responseData = responseData;
  }
}

function responseMessage(data, fallback) {
  return data && typeof data === 'object' && typeof data.message === 'string' ? data.message : fallback;
}

function retryAfterMilliseconds(headerValue) {
  if (headerValue == null) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(headerValue));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function numericPreview(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(4)) : 0;
}

export function buildAccountUserAgent(accountId) {
  const digest = crypto.createHash('sha256').update(String(accountId)).digest();
  const chromeMajor = 128 + (digest[0] % 12);
  const chromeBuild = 6000 + (digest.readUInt16BE(1) % 2000);
  const chromePatch = digest.readUInt16BE(3) % 1000;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36`;
}

export class ATFClient {
  constructor({
    initData,
    userInfo,
    deviceId,
    proxy = null,
    baseUrl,
    webappUrl,
    timeoutMs = 20_000,
    maxAttempts = 3,
    retryDelayMs = 2_000,
    maxRetryDelayMs = 15_000,
    userAgent = null,
    signal,
    http = null
  }) {
    if (!initData || !userInfo?.id || !deviceId) throw new Error('ATFClient membutuhkan initData, userInfo, dan deviceId');
    this.initData = initData.trim();
    this.tgId = Number.parseInt(userInfo.id, 10);
    this.username = String(userInfo.username || '').replace(/^@/, '');
    this.deviceId = deviceId;
    this.proxy = proxy;
    this.baseUrl = new URL(baseUrl);
    this.webappUrl = new URL(webappUrl);
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.userAgent = String(userAgent || buildAccountUserAgent(this.tgId));
    this.signal = signal;
    this.sessionToken = null;

    const axiosConfig = {
      timeout: timeoutMs,
      signal,
      maxRedirects: 0,
      validateStatus: () => true,
      maxContentLength: 2_000_000,
      maxBodyLength: 1_000_000
    };
    if (proxy) {
      const agent = new HttpsProxyAgent(proxy);
      axiosConfig.httpsAgent = agent;
      axiosConfig.httpAgent = agent;
      axiosConfig.proxy = false;
    }
    this.http = http || axios.create(axiosConfig);
  }

  getHeaders() {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': 'application/json',
      Origin: this.baseUrl.origin,
      Referer: this.webappUrl.toString(),
      'X-Requested-With': 'XMLHttpRequest',
      'X-Telegram-Init-Data': this.initData,
      'User-Agent': this.userAgent
    };
    if (this.sessionToken) headers['X-ATF-TMA-Session'] = this.sessionToken;
    return headers;
  }

  buildBody(extra = {}) {
    return {
      initData: this.initData,
      request_id: crypto.randomUUID(),
      device_id: this.deviceId,
      tg_id: this.tgId,
      ...extra
    };
  }

  async sendAction(action, extraBody = {}) {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Action API tidak diizinkan: ${action}`);
    const url = new URL(this.baseUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('t', String(Date.now()));

    // Body dibuat sekali agar request_id tetap sama pada seluruh retry.
    const requestBody = this.buildBody(extraBody);
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.signal?.aborted) throw createAbortError();
      try {
        const response = await this.http.post(url.toString(), requestBody, {
          headers: this.getHeaders(),
          signal: this.signal
        });
        const status = Number(response.status) || 0;
        const data = response.data;

        if (status >= 200 && status < 300) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new ATFRequestError(`Respons ${action} bukan JSON object`, {
              action, status, retryable: true, code: 'INVALID_RESPONSE'
            });
          }
          return data;
        }

        const message = responseMessage(data, `HTTP ${status}`);
        if (status === 401 || status === 403) {
          throw new ATFRequestError(message, { action, status, code: 'AUTH_FAILED', responseData: data });
        }
        if (status === 429) {
          const error = new ATFRequestError(message, { action, status, retryable: true, code: 'RATE_LIMITED', responseData: data });
          error.retryAfterMs = retryAfterMilliseconds(response.headers?.['retry-after']);
          throw error;
        }
        if (status >= 500) {
          throw new ATFRequestError(message, { action, status, retryable: true, code: 'SERVER_ERROR', responseData: data });
        }
        throw new ATFRequestError(message, { action, status, code: 'CLIENT_ERROR', responseData: data });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED' || this.signal?.aborted) throw createAbortError();

        if (error instanceof ATFRequestError) {
          lastError = error;
        } else {
          lastError = new ATFRequestError(error?.message || 'Network error', {
            action,
            status: error?.response?.status || 0,
            retryable: !error?.response || Number(error.response.status) >= 500,
            code: error?.code || 'NETWORK_ERROR',
            responseData: error?.response?.data || null
          });
        }

        if (!lastError.retryable || attempt >= this.maxAttempts) throw lastError;

        const exponential = Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** (attempt - 1)));
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
        const delay = Math.min(this.maxRetryDelayMs, Math.max(lastError.retryAfterMs || 0, exponential + jitter));
        log.warn(`${action} gagal (percobaan ${attempt}/${this.maxAttempts}): ${lastError.message}. Retry ${Math.ceil(delay / 1000)}s.`);
        await sleep(delay, this.signal);
      }
    }
    throw lastError;
  }

  async login(referralCode = '') {
    const normalizedReferral = String(referralCode || '').trim();
    if (normalizedReferral && (!/^\d{4,20}$/.test(normalizedReferral) || normalizedReferral === String(this.tgId))) {
      throw new Error('Referral code tidak valid atau sama dengan akun sendiri');
    }
    const data = await this.sendAction('login', {
      username: this.username,
      ...(normalizedReferral ? { ref_code: normalizedReferral } : {})
    });
    if (data.status !== 'success') {
      throw new ATFRequestError(responseMessage(data, 'Login gagal'), { action: 'login', code: data.reason || 'LOGIN_FAILED', responseData: data });
    }
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) {
      throw new ATFRequestError('Login berhasil tanpa object user', { action: 'login', code: 'INVALID_LOGIN_RESPONSE' });
    }
    if (data.tma_session_token) this.sessionToken = String(data.tma_session_token);
    return data;
  }

  async getEntryCaptchaStatus() {
    const data = await this.sendAction('captcha_status');
    if (data?.status !== 'success') {
      throw new ATFRequestError(responseMessage(data, 'Status Turnstile entry gagal dimuat'), {
        action: 'captcha_status',
        code: data?.reason || 'CAPTCHA_STATUS_FAILED',
        responseData: data
      });
    }
    return {
      ...data,
      captcha_enabled: Boolean(data.captcha_enabled),
      captcha_required: Boolean(data.captcha_required),
      config_ready: Boolean(data.config_ready),
      site_key: String(data.site_key || '').trim()
    };
  }

  async verifyEntryCaptcha(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken || normalizedToken.length > 16_384 || /[\u0000-\u001f\u007f]/.test(normalizedToken)) {
      throw new Error('Token Turnstile tidak valid');
    }
    const data = await this.sendAction('verify_entry_captcha', { captcha_token: normalizedToken });
    if (data?.status !== 'success') {
      throw new ATFRequestError(responseMessage(data, 'Verifikasi Turnstile entry gagal'), {
        action: 'verify_entry_captcha',
        code: data?.reason || 'CAPTCHA_VERIFY_FAILED',
        responseData: data
      });
    }
    return data;
  }

  claim(claimPreview = 0, requestId = '') {
    return this.sendAction('claim', {
      claim_preview: numericPreview(claimPreview),
      ...(requestId ? { request_id: String(requestId) } : {})
    });
  }

  getWithdrawPuzzle(amount) {
    const normalizedAmount = numericPreview(amount);
    if (normalizedAmount < 500) throw new Error('Minimum withdrawal adalah 500 ATF');
    return this.sendAction('get_withdraw_puzzle', { amount: normalizedAmount });
  }

  withdraw({ amount, captchaId, captchaAnswer, requestId = '' }) {
    const normalizedAmount = numericPreview(amount);
    const normalizedCaptchaId = String(captchaId || '').trim();
    const normalizedAnswer = String(captchaAnswer || '').trim();
    if (normalizedAmount < 500) throw new Error('Minimum withdrawal adalah 500 ATF');
    if (!/^[a-f0-9]{16,128}$/i.test(normalizedCaptchaId)) throw new Error('ID CAPTCHA withdrawal tidak valid');
    if (!/^[a-z0-9]{5}$/i.test(normalizedAnswer)) throw new Error('Jawaban CAPTCHA withdrawal harus lima karakter alfanumerik');
    return this.sendAction('withdraw', {
      amount: normalizedAmount,
      withdraw_captcha_id: normalizedCaptchaId,
      withdraw_captcha_answer: normalizedAnswer,
      ...(requestId ? { request_id: String(requestId) } : {})
    });
  }

  getWithdrawHistory() {
    return this.sendAction('get_withdraw_history');
  }

  async getMathChallenge(scope = 'start_mine') {
    if (!/^[a-z0-9_:-]{1,80}$/i.test(String(scope))) {
      throw new Error('Scope security question tidak valid');
    }
    const data = await this.sendAction('get_math_challenge', { scope: String(scope) });
    const challengeId = String(data?.challenge_id || '').trim();
    const question = String(data?.question || '').trim();
    if (data?.status !== 'success' || !challengeId || !question || challengeId.length > 256 || question.length > 120) {
      throw new ATFRequestError(responseMessage(data, 'Security question tidak valid'), {
        action: 'get_math_challenge',
        code: data?.reason || 'INVALID_MATH_CHALLENGE',
        responseData: data
      });
    }
    return {
      ...data,
      challenge_id: challengeId,
      question,
      expires_in: Math.max(1, Math.min(300, Number.parseInt(data.expires_in || '180', 10) || 180))
    };
  }

  async getWalletProofPayload(force = true) {
    const data = await this.sendAction('get_wallet_proof_payload', { force: force ? 1 : 0 });
    const payload = String(data?.payload || '').trim();
    const expiresAt = Math.max(0, Number.parseInt(data?.expires_at || '0', 10) || 0);
    if (data?.status !== 'success' || !payload || payload.length > 4096 || expiresAt <= Math.floor(Date.now() / 1000) + 10) {
      throw new ATFRequestError(responseMessage(data, 'Payload TON Proof tidak valid atau kedaluwarsa'), {
        action: 'get_wallet_proof_payload',
        code: data?.reason || 'INVALID_WALLET_PROOF_PAYLOAD',
        responseData: data
      });
    }
    return { ...data, payload, expires_at: expiresAt };
  }

  async syncWallet({ wallet, publicKey, walletStateInit, network = '-239', proof, refreshHolding = false }) {
    const normalizedWallet = String(wallet || '').trim();
    const normalizedPublicKey = String(publicKey || '').trim().toLowerCase();
    const normalizedStateInit = String(walletStateInit || '').trim();
    if (!/^-?\d+:[a-f0-9]{64}$/i.test(normalizedWallet)) throw new Error('Alamat raw TON wallet tidak valid');
    if (!/^[a-f0-9]{64}$/.test(normalizedPublicKey)) throw new Error('Public key TON wallet tidak valid');
    if (!normalizedStateInit || normalizedStateInit.length > 16_384) throw new Error('Wallet state-init tidak valid');
    if (!/^-?\d+$/.test(String(network))) throw new Error('Network TON tidak valid');
    if (!proof || typeof proof !== 'object' || !proof.signature || !proof.payload || !proof.domain) {
      throw new Error('TON Proof tidak lengkap');
    }

    return this.sendAction('sync_wallet', {
      wallet: normalizedWallet,
      public_key: normalizedPublicKey,
      wallet_state_init: normalizedStateInit,
      network: String(network),
      proof,
      refresh_holding: refreshHolding ? 1 : 0
    });
  }

  async syncWalletStats(wallet) {
    const normalizedWallet = String(wallet || '').trim();
    if (!/^-?\d+:[a-f0-9]{64}$/i.test(normalizedWallet)) throw new Error('Alamat raw TON wallet tidak valid');
    return this.sendAction('sync_wallet', {
      wallet: normalizedWallet,
      public_key: '',
      wallet_state_init: '',
      network: '',
      proof: null,
      refresh_holding: 0
    });
  }

  startMine(challenge = null) {
    if (challenge == null) return this.sendAction('start_mine');
    const challengeId = String(challenge.challengeId ?? challenge.math_challenge_id ?? '').trim();
    const answer = String(challenge.answer ?? challenge.math_answer ?? '').trim();
    if (!challengeId || challengeId.length > 256 || /[\u0000-\u001f\u007f]/.test(challengeId)) {
      throw new Error('ID security question tidak valid');
    }
    if (!/^-?\d{1,4}$/.test(answer)) {
      throw new Error('Jawaban security question harus berupa angka maksimal 4 digit');
    }
    return this.sendAction('start_mine', {
      math_challenge_id: challengeId,
      math_answer: answer
    });
  }

  activateBoost(displayPreview = 0) {
    return this.sendAction('activate_boost', { display_preview: numericPreview(displayPreview) });
  }

  syncMiningState() {
    return this.sendAction('sync_mining_state', { client_boost_cycle_seconds: 15 });
  }

  startTask(taskId, clientStartedAt) {
    const startedAt = Number.parseInt(clientStartedAt, 10);
    const now = Math.floor(Date.now() / 1000);
    if (!/^[a-z0-9_:-]{1,80}$/i.test(String(taskId)) || !startedAt || startedAt > now + 5) {
      throw new Error('Parameter start task tidak valid');
    }
    return this.sendAction('start_task', { task_id: taskId, client_started_at: startedAt });
  }

  claimTask(taskId, clientStartedAt = 0) {
    const startedAt = Math.max(0, Number.parseInt(clientStartedAt, 10) || 0);
    if (!/^[a-z0-9_:-]{1,80}$/i.test(String(taskId))) throw new Error('Task ID tidak valid');
    return this.sendAction('claim_task', { task_id: taskId, client_started_at: startedAt });
  }

  getFriends() {
    return this.sendAction('get_friends');
  }

  claimReferrals() {
    return this.sendAction('claim_referrals');
  }

  claimTeamWallet() {
    return this.sendAction('claim_team_wallet');
  }
}
