function normalizeProxy(proxy) {
  return proxy ? new URL(String(proxy)).toString() : null;
}

export class WithdrawProxyPool {
  constructor(proxies = [], { canUse = () => true } = {}) {
    this.proxies = [...new Set(proxies.map(normalizeProxy).filter(Boolean))];
    this.canUse = canUse;
    this.used = new Set();
  }

  take(preferredProxy = null) {
    const preferred = normalizeProxy(preferredProxy);
    const candidates = preferred
      ? [preferred, ...this.proxies.filter((proxy) => proxy !== preferred)]
      : this.proxies;

    for (const proxy of candidates) {
      if (this.used.has(proxy) || !this.canUse(proxy)) continue;
      this.used.add(proxy);
      return proxy;
    }
    return null;
  }

  get configuredCount() {
    return this.proxies.length;
  }

  get usedCount() {
    return this.used.size;
  }

  get remainingCount() {
    return this.proxies.filter((proxy) => !this.used.has(proxy) && this.canUse(proxy)).length;
  }
}
