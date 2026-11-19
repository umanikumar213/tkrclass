const pool = require('../db');
const { definitions, format } = require('./spotlight-texts');
const { SpotlightCache } = require('./spotlight-cache');
const cache = new SpotlightCache({ ttl: 300000, max: 1 });
function valid(def, value) {
  if (def.type === 'text') {
    if (typeof value !== 'string' || value.length > def.maxLength) return false;
    if (def.key === 'profile_remove_url') {
      if (value === '#' || /^\/(?!\/)[^\s\\]*$/.test(value)) return true;
      if (/[\s<>"\\]/.test(value)) return false;
      try {
        const url = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    }
    return true;
  }
  if (def.type === 'number') return Number.isInteger(value) && value >= def.min && value <= def.max;
  if (def.type === 'boolean') return typeof value === 'boolean';
  return Array.isArray(value) && value.length <= 30 && new Set(value).size === value.length &&
    value.every(year => typeof year === 'string' && year.length > 0 && year.length <= 100);
}
async function getContent() {
  const cached = cache.get('content');
  if (cached !== undefined) return cached;
  const revision = cache.revision;
  const { rows } = await pool.query('SELECT key,value FROM spotlight_settings');
  const values = Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, def.defaultValue]));
  for (const row of rows) {
    const def = definitions[row.key];
    if (!def) continue;
    try {
      const value = def.type === 'text' ? row.value : JSON.parse(row.value);
      if (valid(def, value)) values[row.key] = value;
    } catch { /* Invalid old overrides cannot replace validated defaults. */ }
  }
  const result = { texts: {}, settings: {} };
  for (const [key, def] of Object.entries(definitions)) {
    result[def.type === 'text' ? 'texts' : 'settings'][key] = values[key];
  }
  if (revision === cache.revision) cache.set('content', result);
  return result;
}
async function contentMiddleware(req, res, next) {
  try { req.spotlightContent = await getContent(); next(); } catch (error) { next(error); }
}
function message(req, key, values = {}) {
  return format(req.spotlightContent?.texts[key] ?? definitions[key]?.defaultValue ?? key, values);
}
function clearContent() { cache.clear(); }
module.exports = { getContent, contentMiddleware, message, clearContent, valid };
