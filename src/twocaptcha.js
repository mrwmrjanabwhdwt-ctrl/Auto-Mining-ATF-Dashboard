import axios from 'axios';
import { sleep } from './utils.js';

const API_BASE = 'https://api.2captcha.com';

export class TwoCaptchaError extends Error {
  constructor(message, code = 'TWOCAPTCHA_ERROR') {
    super(message);
    this.name = 'TwoCaptchaError';
    this.code = code;
  }
}

function requireApiKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new TwoCaptchaError('TWOCAPTCHA_API_KEY belum diisi atau formatnya tidak valid', 'API_KEY_INVALID');
  }
  return key;
}

function normalizeCaptchaImage(value) {
  const image = String(value || '').trim();
  const match = image.match(/^data:image\/(?:png|jpe?g|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new TwoCaptchaError('Gambar CAPTCHA ATF bukan data-URI PNG/JPEG/GIF yang valid', 'IMAGE_INVALID');
  const base64 = match[1].replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > 100 * 1024) {
    throw new TwoCaptchaError('Ukuran gambar CAPTCHA kosong atau melebihi batas 100 kB', 'IMAGE_SIZE_INVALID');
  }
  return base64;
}

function responseError(data, fallback) {
  if (!data || typeof data !== 'object') return new TwoCaptchaError(fallback, 'INVALID_RESPONSE');
  if (Number(data.errorId || 0) === 0) return null;
  return new TwoCaptchaError(
    String(data.errorDescription || data.errorCode || fallback),
    String(data.errorCode || 'TWOCAPTCHA_API_ERROR')
  );
}

export async function solveImageCaptchaWith2Captcha({
  apiKey,
  image,
  timeoutMs = 180_000,
  pollIntervalMs = 5_000,
  signal,
  http = axios,
  sleepFn = sleep,
  onProgress = () => {}
}) {
  const clientKey = requireApiKey(apiKey);
  const body = normalizeCaptchaImage(image);
  const requestConfig = {
    timeout: 20_000,
    signal,
    headers: { 'Content-Type': 'application/json' }
  };

  onProgress('Mengirim CAPTCHA gambar ke 2Captcha.');
  let created;
  try {
    created = await http.post(`${API_BASE}/createTask`, {
      clientKey,
      task: {
        type: 'ImageToTextTask',
        body,
        phrase: false,
        case: false,
        numeric: 4,
        math: false,
        minLength: 5,
        maxLength: 5,
        comment: 'Enter the five letters and numbers shown in the image'
      },
      languagePool: 'en'
    }, requestConfig);
  } catch (error) {
    throw new TwoCaptchaError(`Gagal membuat task 2Captcha: ${error.message}`, 'CREATE_REQUEST_FAILED');
  }
  const createData = created?.data;
  const createError = responseError(createData, 'Respons createTask 2Captcha tidak valid');
  if (createError) throw createError;
  const taskId = Number.parseInt(createData?.taskId || '0', 10) || 0;
  if (!taskId) throw new TwoCaptchaError('2Captcha tidak mengembalikan taskId', 'TASK_ID_MISSING');

  const deadline = Date.now() + Math.max(30_000, timeoutMs);
  while (!signal?.aborted && Date.now() < deadline) {
    await sleepFn(Math.max(1_000, pollIntervalMs), signal);
    onProgress(`Menunggu hasil 2Captcha task ${taskId}.`);
    let result;
    try {
      result = await http.post(`${API_BASE}/getTaskResult`, { clientKey, taskId }, requestConfig);
    } catch (error) {
      throw new TwoCaptchaError(`Gagal membaca hasil 2Captcha: ${error.message}`, 'RESULT_REQUEST_FAILED');
    }
    const data = result?.data;
    const resultError = responseError(data, 'Respons getTaskResult 2Captcha tidak valid');
    if (resultError) throw resultError;
    if (data?.status === 'processing') continue;
    if (data?.status !== 'ready') throw new TwoCaptchaError('Status task 2Captcha tidak dikenal', 'RESULT_STATUS_INVALID');
    const text = String(data?.solution?.text || '').trim();
    if (!/^[a-z0-9]{5}$/i.test(text)) {
      throw new TwoCaptchaError('Jawaban 2Captcha bukan lima karakter alfanumerik', 'SOLUTION_INVALID');
    }
    return { text, taskId };
  }
  if (signal?.aborted) throw new TwoCaptchaError('Proses 2Captcha dibatalkan', 'ABORTED');
  throw new TwoCaptchaError('2Captcha belum memberikan jawaban sebelum timeout', 'TIMEOUT');
}

export async function reportIncorrectImageCaptcha({ apiKey, taskId, http = axios, signal }) {
  const clientKey = requireApiKey(apiKey);
  const normalizedTaskId = Number.parseInt(taskId || '0', 10) || 0;
  if (!normalizedTaskId) return false;
  try {
    const response = await http.post(`${API_BASE}/reportIncorrectImageCaptcha`, {
      clientKey,
      taskId: normalizedTaskId
    }, { timeout: 15_000, signal, headers: { 'Content-Type': 'application/json' } });
    return Number(response?.data?.errorId || 0) === 0 && response?.data?.status === 'success';
  } catch {
    return false;
  }
}
