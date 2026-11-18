// Bounded LRU with both entry and byte budgets. Null is an intentional negative cache hit.
class SpotlightCache {
  constructor({ ttl = 300000, max = 200, bytes = Infinity } = {}) {
    this.entries = new Map();
    this.ttl = ttl;
    this.max = max;
    this.budget = bytes;
    this.bytes = 0;
    this.revision = 0;
  }
  get(key) {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (item.expires <= Date.now()) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, item);
    return item.value;
  }
  set(key, value) {
    this.delete(key);
    const size = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(JSON.stringify(value) || '');
    if (size > this.budget) return value;
    while (this.entries.size >= this.max || this.bytes + size > this.budget) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, size, expires: Date.now() + this.ttl });
    this.bytes += size;
    return value;
  }
  delete(key) {
    const item = this.entries.get(key);
    if (item) this.bytes -= item.size;
    this.entries.delete(key);
  }
  invalidate(key) { this.revision++; this.delete(key); }
  clear() { this.revision++; this.entries.clear(); this.bytes = 0; }
}

module.exports = { SpotlightCache };
