import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJsonFile, writeJsonAtomic } from './utils.js';

function stateKey(sessionPath, referralCode) {
  return crypto.createHash('sha256').update(`${sessionPath}\0${referralCode}`).digest('hex');
}

export class ReferralState {
  constructor(statePath, now = () => Date.now()) {
    this.statePath = statePath;
    this.now = now;
    this.state = { version: 1, accounts: {} };
    if (fs.existsSync(statePath)) {
      try {
        const parsed = readJsonFile(statePath, 'referral state');
        if (parsed?.version === 1 && parsed.accounts && typeof parsed.accounts === 'object') this.state = parsed;
      } catch {
        // A corrupt local state can be recreated safely.
      }
    }
  }

  plan(sessionPath, referralCode) {
    if (!/^\d{4,20}$/.test(String(referralCode || ''))) return null;
    const key = stateKey(sessionPath, referralCode);
    const entry = this.state.accounts[key] || {};
    return {
      key,
      code: String(referralCode),
      needsStartBot: !entry.botStartedAt,
      needsFinalize: !entry.completedAt
    };
  }

  markBotStarted(key) {
    const entry = this.state.accounts[key] || {};
    this.state.accounts[key] = { ...entry, botStartedAt: entry.botStartedAt || this.now() };
    this.save();
  }

  markCompleted(key) {
    const entry = this.state.accounts[key] || {};
    this.state.accounts[key] = {
      ...entry,
      botStartedAt: entry.botStartedAt || this.now(),
      completedAt: this.now()
    };
    this.save();
  }

  save() {
    // Keys are hashes of session path + referral code; raw values are not persisted.
    writeJsonAtomic(this.statePath, this.state);
  }
}
