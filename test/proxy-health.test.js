import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ProxyHealth } from '../src/proxy-health.js';

test('proxy dikarantina setelah batas kegagalan dan pulih setelah sukses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-proxy-'));
  const statePath = path.join(root, 'health.json');
  let currentTime = 1_000_000;
  const health = new ProxyHealth({ statePath, failureThreshold: 2, cooldownMinutes: 1, now: () => currentTime });
  const proxy = 'http://user:secret@127.0.0.1:8080';
  assert.equal(health.recordFailure(proxy).disabled, false);
  assert.equal(health.recordFailure(proxy).disabled, true);
  assert.equal(health.canUse(proxy), false);
  assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /user|secret|127\.0\.0\.1/);
  currentTime += 61_000;
  assert.equal(health.canUse(proxy), true);
  health.recordSuccess(proxy);
  assert.equal(health.getRecord(proxy), null);
});
