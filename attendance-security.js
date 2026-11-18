function isPortalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && url.host === '103.171.190.44' && url.pathname.startsWith('/TKRCET/')
      && !url.username && !url.password;
  } catch { return false; }
}
class BoundedCache extends Map {
  constructor(maxEntries = 500, ttl = 60000) {
    super();
    this.maxEntries = maxEntries;
    this.ttl = ttl;
  }
  get(key) {
    const entry = super.get(key);
    if (entry && Date.now() - entry.at >= this.ttl) { this.delete(key); return undefined; }
    return entry;
  }
  set(key, value) {
    this.delete(key);
    while (this.size >= this.maxEntries) this.delete(this.keys().next().value);
    return super.set(key, value);
  }
  prune() { for (const [key, value] of this) if (Date.now() - value.at >= this.ttl) this.delete(key); }
}
module.exports = { isPortalUrl, BoundedCache };
