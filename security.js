const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');

const clientIp = require('./lib/client-ip');
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdminPassword(value) {
  return Boolean(process.env.ADMIN_PASSWORD) && safeEqual(value, process.env.ADMIN_PASSWORD);
}
function parseCookies(header) {
  const cookies = Object.create(null);
  for (const pair of String(header || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    try { cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim()); }
    catch { /* Malformed cookies are untrusted, not a server error. */ }
  }
  return cookies;
}
function signVisitor(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(id).digest('base64url');
}
function getReactorHash(req) {
  if (!process.env.SESSION_SECRET) return null;
  // Keep the existing cookie name/signature compatible with Reyi visitors.
  const token = parseCookies(req.headers.cookie).reyi_visitor;
  if (!token || token.length > 256) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  if (!/^[a-f0-9-]{36}$/i.test(id) || !safeEqual(token.slice(dot + 1), signVisitor(id))) return null;
  return crypto.createHash('sha256').update(id).digest('hex');
}
function ensureReactorIdentity(req, res) {
  const existing = getReactorHash(req);
  if (existing || !process.env.SESSION_SECRET) return existing;
  const id = crypto.randomUUID();
  res.append('Set-Cookie', `reyi_visitor=${encodeURIComponent(`${id}.${signVisitor(id)}`)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  return crypto.createHash('sha256').update(id).digest('hex');
}

function routeLimit(limit, windowMs) {
  return rateLimit({
    windowMs, limit, standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' },
  });
}
function submissionGuard(entries, windowMs) {
  return (req, res, next) => {
    const ip = clientIp(req), now = Date.now(), previous = entries.get(ip);
    if (previous !== undefined && now - previous < windowMs) {
      return res.status(429).json({ success: false, message: `Please wait ${Math.ceil((windowMs - (now - previous)) / 60000)} minute(s) before posting again.` });
    }
    entries.set(ip, now); // Reserve synchronously, before parsing or accepting files.
    const release = () => { if (entries.get(ip) === now) entries.delete(ip); };
    res.once('finish', () => { if (res.statusCode >= 400) release(); });
    res.once('close', () => { if (!res.writableFinished) release(); });
    next();
  };
}
module.exports = { safeEqual, isAdminPassword, parseCookies, getReactorHash, ensureReactorIdentity, routeLimit, submissionGuard };
