import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMultiBotProxy, parseMultiBotResponse, solveTurnstileWithMultiBot } from '../src/multibot.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

test('parser MultiBot menerima JSON dan format classic OK', () => {
  assert.deepEqual(parseMultiBotResponse('{"status":1,"request":"12345"}'), { status: 1, request: '12345' });
  assert.deepEqual(parseMultiBotResponse('OK|token-abc'), { status: 1, request: 'token-abc' });
});

test('proxy akun diubah ke format LOGIN:PASS@IP:PORT', () => {
  assert.equal(formatMultiBotProxy('http://user:p%40ss@127.0.0.1:8080'), 'user:p@ss@127.0.0.1:8080');
});

test('solver submit task, menunggu, lalu mengembalikan token', async () => {
  const requests = [];
  const progress = [];
  const replies = [
    response('{"status":1,"request":"task-1"}'),
    response('{"status":0,"request":"CAPCHA_NOT_READY"}'),
    response('{"status":1,"request":"turnstile-token"}')
  ];
  const token = await solveTurnstileWithMultiBot({
    apiKey: 'api-key',
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

  assert.equal(token, 'turnstile-token');
  assert.equal(requests[0].options.body.get('method'), 'turnstile');
  assert.equal(requests[0].options.body.get('sitekey'), 'site-key');
  assert.match(requests[1].url, /id=task-1/);
  assert.ok(progress.some((message) => message.includes('Mengirim task')));
  assert.ok(progress.some((message) => message.includes('Polling #1')));
  assert.ok(progress.some((message) => message.includes('token belum siap')));
  assert.ok(progress.some((message) => message.includes('Token diterima')));
});
