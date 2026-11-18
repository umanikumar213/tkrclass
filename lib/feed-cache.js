class FeedCache extends Map {
  constructor(ttl = 300000, limit = 200) { super(); this.ttl = ttl; this.limit = limit; }
  get(key) {
    const entry = super.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { this.delete(key); return null; }
    return entry.payload;
  }
  set(key, payload) {
    this.delete(key);
    while (this.size >= this.limit) this.delete(this.keys().next().value);
    return super.set(key, { payload, expiresAt: Date.now() + this.ttl });
  }
}
function feedPage(value) {
  const page = Math.max(1, parseInt(value, 10) || 1);
  return { page: Number.isFinite(page) ? page : 201, beyondLimit: page > 200 };
}
module.exports = { FeedCache, feedPage };
