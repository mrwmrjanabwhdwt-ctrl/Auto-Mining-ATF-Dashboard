import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJsonFile, writeJsonAtomic } from './utils.js';

function proxyKey(proxy) {
  return crypto.createHash('sha256').update(String(proxy)).digest('hex');
}

export class ProxyHealth {
  constructor({ statePath, failureThreshold = 3, cooldownMinutes = 30, now = () => Date.now() }) {
    this.statePath = statePath;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
    this.now = now;
    this.state = { version: 1, proxies: {} };
    if (fs.existsSync(statePath)) {
      try {
        const parsed = readJsonFile(statePath, 'proxy health state');
        if (parsed?.version === 1 && parsed.proxies && typeof parsed.proxies === 'object') this.state = parsed;
      } catch {
        // Corrupt health state is safe to reset; no credential is stored here.
      }
    }
  }

  getRecord(proxy) {
    if (!proxy) return null;
    return this.state.proxies[proxyKey(proxy)] || null;
  }

  cooldownRemainingSeconds(proxy) {
    const record = this.getRecord(proxy);
    return record ? Math.max(0, Math.ceil((Number(record.disabledUntil) - this.now()) / 1000)) : 0;
  }

  canUse(proxy) {
    return !proxy || this.cooldownRemainingSeconds(proxy) === 0;
  }

  recordSuccess(proxy) {
    if (!proxy) return;
    const key = proxyKey(proxy);
    if (this.state.proxies[key]) {
      delete this.state.proxies[key];
      this.save();
    }
  }

  recordFailure(proxy) {
    if (!proxy) return { disabled: false, failures: 0 };
    const key = proxyKey(proxy);
    const current = this.state.proxies[key] || { failures: 0, disabledUntil: 0, updatedAt: 0 };
    const failures = Number(current.failures || 0) + 1;
    const disabledUntil = failures >= this.failureThreshold ? this.now() + this.cooldownMs : 0;
    this.state.proxies[key] = { failures, disabledUntil, updatedAt: this.now() };
    this.save();
    return { disabled: disabledUntil > 0, failures, disabledUntil };
  }

  save() {
    // Store only SHA-256 identifiers; proxy hosts and credentials never enter this file.
    writeJsonAtomic(this.statePath, this.state);
  }
}
