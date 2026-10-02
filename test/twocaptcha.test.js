import test from 'node:test';
import assert from 'node:assert/strict';
import { reportIncorrectImageCaptcha, solveImageCaptchaWith2Captcha } from '../src/twocaptcha.js';

test('2Captcha ImageToTextTask dikirim lalu dipoll sampai ready', async () => {
  const requests = [];
  let resultPolls = 0;
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      if (url.endsWith('/createTask')) return { data: { errorId: 0, taskId: 12345 } };
      resultPolls += 1;
      if (resultPolls === 1) return { data: { errorId: 0, status: 'processing' } };
      return { data: { errorId: 0, status: 'ready', solution: { text: 'HJU24' } } };
    }
  };
  const result = await solveImageCaptchaWith2Captcha({
    apiKey: 'a'.repeat(32),
    image: 'data:image/png;base64,iVBORw0KGgo=',
    signal: new AbortController().signal,
    http,
    sleepFn: async () => {}
  });

  assert.equal(result.text, 'HJU24');
  assert.equal(result.taskId, 12345);
  assert.equal(requests[0].body.task.type, 'ImageToTextTask');
  assert.equal(requests[0].body.task.numeric, 4);
  assert.equal(requests[0].body.task.minLength, 5);
  assert.equal(requests[0].body.task.maxLength, 5);
  assert.equal(resultPolls, 2);
});

test('jawaban image captcha yang ditolak dapat dilaporkan ke 2Captcha', async () => {
  let request;
  const http = {
    async post(url, body) {
      request = { url, body };
      return { data: { errorId: 0, status: 'success' } };
    }
  };
  const reported = await reportIncorrectImageCaptcha({
    apiKey: 'b'.repeat(32),
    taskId: 987,
    http,
    signal: new AbortController().signal
  });
  assert.equal(reported, true);
  assert.match(request.url, /reportIncorrectImageCaptcha$/);
  assert.equal(request.body.taskId, 987);
});
