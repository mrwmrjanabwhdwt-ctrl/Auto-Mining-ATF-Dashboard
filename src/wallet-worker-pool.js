import { isAbortError, sleep } from './utils.js';

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} harus integer positif`);
  return value;
}

export class WalletWorkerPool {
  #active = new Map();
  #idleResolvers = new Set();
  #known = new Set();
  #queue = [];

  constructor({
    maxWorkers = 10,
    retryDelayMs = 15_000,
    signal,
    runJob,
    onEvent = () => {},
    sleepFn = sleep
  }) {
    this.maxWorkers = requirePositiveInteger(maxWorkers, 'maxWorkers');
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('retryDelayMs tidak valid');
    if (typeof runJob !== 'function') throw new Error('runJob wajib berupa function');
    if (typeof onEvent !== 'function') throw new Error('onEvent wajib berupa function');
    if (typeof sleepFn !== 'function') throw new Error('sleepFn wajib berupa function');

    this.retryDelayMs = retryDelayMs;
    this.signal = signal;
    this.runJob = runJob;
    this.onEvent = onEvent;
    this.sleepFn = sleepFn;

    signal?.addEventListener('abort', () => {
      for (const job of this.#queue) this.#known.delete(job.key);
      this.#queue.length = 0;
      this.#emit({ type: 'queue_cleared' });
      this.#resolveIdleIfNeeded();
    }, { once: true });
  }

  get activeCount() {
    return this.#active.size;
  }

  get queuedCount() {
    return this.#queue.length;
  }

  get size() {
    return this.#known.size;
  }

  has(key) {
    return this.#known.has(String(key || '').trim());
  }

  enqueue(job) {
    const key = String(job?.key || '').trim();
    if (!key) throw new Error('Wallet worker job wajib memiliki key');
    if (this.signal?.aborted || this.#known.has(key)) return false;

    const queuedJob = { ...job, key };
    this.#known.add(key);
    this.#queue.push(queuedJob);
    this.#emit({ type: 'queued', job: queuedJob });
    this.#drain();
    return true;
  }

  waitForIdle() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleResolvers.add(resolve));
  }

  #snapshot(extra = {}) {
    return {
      active: this.activeCount,
      queued: this.queuedCount,
      total: this.size,
      ...extra
    };
  }

  #emit(event) {
    try {
      this.onEvent(this.#snapshot(event));
    } catch {
      // Logging/telemetry must never stop worker scheduling.
    }
  }

  #drain() {
    if (this.signal?.aborted) return;
    while (this.#active.size < this.maxWorkers && this.#queue.length > 0) {
      const job = this.#queue.shift();
      const task = Promise.resolve()
        .then(() => this.#runWorker(job))
        .finally(() => {
          this.#active.delete(job.key);
          this.#known.delete(job.key);
          this.#emit({ type: 'released', job });
          this.#drain();
          this.#resolveIdleIfNeeded();
        });
      this.#active.set(job.key, task);
      this.#emit({ type: 'started', job });
    }
  }

  async #runWorker(job) {
    let attempt = 0;
    while (!this.signal?.aborted) {
      attempt += 1;
      let result;
      try {
        result = await this.runJob(job, attempt);
      } catch (error) {
        if (!isAbortError(error)) this.#emit({ type: 'failed', job, attempt, error });
        return;
      }

      if (!result?.retry) {
        this.#emit({ type: 'completed', job, attempt, result });
        return;
      }

      this.#emit({ type: 'retry_wait', job, attempt, result });
      try {
        await this.sleepFn(this.retryDelayMs, this.signal);
      } catch (error) {
        if (!isAbortError(error)) this.#emit({ type: 'failed', job, attempt, error });
        return;
      }
    }
  }

  #resolveIdleIfNeeded() {
    if (this.size !== 0) return;
    for (const resolve of this.#idleResolvers) resolve();
    this.#idleResolvers.clear();
  }
}
