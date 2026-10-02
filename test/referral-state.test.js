import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReferralState } from '../src/referral-state.js';

test('referral StartBot direncanakan satu kali lalu difinalisasi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-referral-'));
  const statePath = path.join(root, 'referrals.json');
  const referral = new ReferralState(statePath, () => 123456);
  const first = referral.plan('D:/sessions/akun1.session', '610911604');
  assert.equal(first.needsStartBot, true);
  assert.equal(first.needsFinalize, true);
  referral.markBotStarted(first.key);
  const second = referral.plan('D:/sessions/akun1.session', '610911604');
  assert.equal(second.needsStartBot, false);
  assert.equal(second.needsFinalize, true);
  referral.markCompleted(second.key);
  const third = referral.plan('D:/sessions/akun1.session', '610911604');
  assert.equal(third.needsStartBot, false);
  assert.equal(third.needsFinalize, false);
  assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /610911604|akun1/);
});
