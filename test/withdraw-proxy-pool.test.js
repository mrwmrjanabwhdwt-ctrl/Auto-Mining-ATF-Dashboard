import test from 'node:test';
import assert from 'node:assert/strict';
import { WithdrawProxyPool } from '../src/withdraw-proxy-pool.js';

const P1 = 'http://user:pass@127.0.0.1:8001';
const P2 = 'http://user:pass@127.0.0.1:8002';
const P3 = 'http://user:pass@127.0.0.1:8003';

test('proxy withdraw hanya diberikan sekali selama satu sesi', () => {
  const pool = new WithdrawProxyPool([P1, P2, P1]);
  assert.equal(pool.configuredCount, 2);
  assert.equal(pool.take(P2), `${P2}/`);
  assert.equal(pool.take(P2), `${P1}/`);
  assert.equal(pool.take(), null);
  assert.equal(pool.usedCount, 2);
});

test('proxy karantina dilewati dan tidak dianggap pernah dipakai', () => {
  const pool = new WithdrawProxyPool([P1, P2, P3], {
    canUse: (proxy) => proxy !== `${P2}/`
  });
  assert.equal(pool.take(P2), `${P1}/`);
  assert.equal(pool.take(), `${P3}/`);
  assert.equal(pool.take(), null);
  assert.equal(pool.usedCount, 2);
});

test('proxy pinned di luar proxy.txt tetap dicatat agar tidak dipakai dua akun', () => {
  const pinned = 'http://127.0.0.1:9000';
  const pool = new WithdrawProxyPool([P1]);
  assert.equal(pool.take(pinned), `${pinned}/`);
  assert.equal(pool.take(pinned), `${P1}/`);
  assert.equal(pool.take(), null);
});
