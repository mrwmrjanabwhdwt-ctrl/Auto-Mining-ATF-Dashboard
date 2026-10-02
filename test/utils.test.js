import test from 'node:test';
import assert from 'node:assert/strict';
import { log, parseInitData, redactSensitive, runWithLogContext, solveSimpleMathQuestion } from '../src/utils.js';

function makeInitData(user, authDate = 1_700_000_000) {
  return new URLSearchParams({ query_id: 'query', user: JSON.stringify(user), auth_date: String(authDate), hash: 'a'.repeat(64) }).toString();
}

test('parseInitData membaca user tanpa double decoding', () => {
  const parsed = parseInitData(makeInitData({ id: 12345, first_name: 'A% B', username: 'sample' }), { nowSeconds: 1_700_000_010, maxAgeSeconds: 60 });
  assert.equal(parsed.id, '12345');
  assert.equal(parsed.firstName, 'A% B');
  assert.equal(parsed.username, 'sample');
});

test('parseInitData menolak data kedaluwarsa', () => {
  assert.throws(() => parseInitData(makeInitData({ id: 12345 }), { nowSeconds: 1_700_001_000, maxAgeSeconds: 60 }), /kedaluwarsa/);
});

test('redactSensitive menyembunyikan initData dan password proxy', () => {
  const output = redactSensitive('hash=secret&auth_date=1 http://user:pass@example.test:8080 initData=secret');
  assert.doesNotMatch(output, /secret|user:pass/);
});

test('solveSimpleMathQuestion menjawab operator aritmetika sederhana', () => {
  assert.equal(solveSimpleMathQuestion('7 × 8'), 56);
  assert.equal(solveSimpleMathQuestion('What is 12 ÷ 3?'), 4);
  assert.equal(solveSimpleMathQuestion('9 minus 14'), -5);
  assert.equal(solveSimpleMathQuestion('6 dikali 7'), 42);
});

test('solveSimpleMathQuestion menolak ekspresi ambigu atau jawaban non-integer', () => {
  assert.equal(solveSimpleMathQuestion('2 + 3 * 4'), null);
  assert.equal(solveSimpleMathQuestion('5 ÷ 2'), null);
  assert.equal(solveSimpleMathQuestion('tidak ada soal'), null);
});

test('runWithLogContext memberi identitas session pada log dashboard', async () => {
  const previousMode = process.env.ATF_TEXTUAL_WORKER;
  const previousConsoleLog = console.log;
  const output = [];
  process.env.ATF_TEXTUAL_WORKER = '1';
  console.log = (message) => output.push(String(message));
  try {
    await runWithLogContext({ accountFile: '12345.session' }, async () => {
      await Promise.resolve();
      log.info('snapshot akun');
    });
  } finally {
    console.log = previousConsoleLog;
    if (previousMode === undefined) delete process.env.ATF_TEXTUAL_WORKER;
    else process.env.ATF_TEXTUAL_WORKER = previousMode;
  }
  assert.equal(output.length, 1);
  assert.match(output[0], /\[ACCOUNT:12345\.session\] snapshot akun/);
});
