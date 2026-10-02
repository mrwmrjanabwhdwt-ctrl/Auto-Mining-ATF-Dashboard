import assert from 'node:assert/strict';
import test from 'node:test';
import { WalletWorkerPool } from '../src/wallet-worker-pool.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('worker pool membatasi concurrency dan menjalankan antrean secara FIFO', async () => {
  const releases = new Map();
  const started = [];
  let concurrent = 0;
  let peak = 0;
  const pool = new WalletWorkerPool({
    maxWorkers: 2,
    retryDelayMs: 0,
    runJob: async (job) => {
      started.push(job.key);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => releases.set(job.key, resolve));
      concurrent -= 1;
      return { retry: false };
    }
  });

  assert.equal(pool.enqueue({ key: 'a' }), true);
  assert.equal(pool.enqueue({ key: 'b' }), true);
  assert.equal(pool.enqueue({ key: 'c' }), true);
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(pool.activeCount, 2);
  assert.equal(pool.queuedCount, 1);

  releases.get('a')();
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(peak, 2);

  releases.get('b')();
  releases.get('c')();
  await pool.waitForIdle();
});

test('worker pool menolak job duplikat yang masih aktif atau mengantre', async () => {
  let release;
  const pool = new WalletWorkerPool({
    maxWorkers: 1,
    runJob: async () => {
      await new Promise((resolve) => { release = resolve; });
      return { retry: false };
    }
  });

  assert.equal(pool.enqueue({ key: 'akun.session' }), true);
  assert.equal(pool.enqueue({ key: 'akun.session' }), false);
  await tick();
  release();
  await pool.waitForIdle();
  assert.equal(pool.has('akun.session'), false);
});

test('setiap akun mempertahankan slot worker selama retry sampai selesai', async () => {
  let calls = 0;
  let sleeps = 0;
  const pool = new WalletWorkerPool({
    maxWorkers: 10,
    retryDelayMs: 15_000,
    sleepFn: async (delay) => {
      assert.equal(delay, 15_000);
      sleeps += 1;
    },
    runJob: async () => {
      calls += 1;
      return { retry: calls < 3 };
    }
  });

  pool.enqueue({ key: 'busy.session' });
  await pool.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});
