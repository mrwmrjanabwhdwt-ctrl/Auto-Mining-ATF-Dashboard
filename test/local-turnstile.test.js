import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTurnstileError, normalizeLocalSolverUrl, solveTurnstileLocally } from '../src/local-turnstile.js';

function response(body, status = 200) {
  return { status, async text() { return JSON.stringify(body); } };
}

test('URL solver lokal hanya menerima HTTP loopback', () => {
  assert.equal(normalizeLocalSolverUrl('http://127.0.0.1:8000').origin, 'http://127.0.0.1:8000');
  assert.throws(
    () => normalizeLocalSolverUrl('http://192.168.1.10:8000'),
    (error) => error instanceof LocalTurnstileError && error.code === 'LOCAL_SOLVER_URL_UNSAFE'
  );
  assert.throws(() => normalizeLocalSolverUrl('https://127.0.0.1:8000'), LocalTurnstileError);
});

test('solver lokal submit, poll process, lalu mengembalikan token', async () => {
  const requests = [];
  const progress = [];
  const replies = [
    response({ task_id: 'local-task-1', status: 'accepted' }, 202),
    response({ status: 'process', message: 'solving turnstile' }, 202),
    response({ status: 'success', elapsed_time: 2.1, value: 'local-turnstile-token' }, 200)
  ];

  const token = await solveTurnstileLocally({
    pageUrl: 'https://example.test/index.html',
    siteKey: 'site-key',
    pollIntervalMs: 1,
    timeoutMs: 1_000,
    http: async (url, options) => {
      requests.push({ url, options });
      return replies.shift();
    },
    sleepFn: async () => {},
    onProgress: (message) => progress.push(message)
  });

  assert.equal(token, 'local-turnstile-token');
  assert.match(requests[0].url, /\/turnstile\?/);
  assert.match(requests[0].url, /sitekey=site-key/);
  assert.match(requests[1].url, /\/result\?id=local-task-1/);
  assert.ok(progress.some((message) => message.includes('Task diterima')));
  assert.ok(progress.some((message) => message.includes('Token diterima')));
});
