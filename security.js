const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');

const clientIp = req => req.ip || req.socket?.remoteAddress || 'unknown';
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

// All password-bearing routes, including media and both boards, share this lockout.
const adminFailures = new Map();
const WINDOW = 15 * 60 * 1000;
function locked(ip) {
  const state = adminFailures.get(ip);
  if (state?.lockedUntil > Date.now()) return Math.ceil((state.lockedUntil - Date.now()) / 60000);
  if (state && (state.lockedUntil || Date.now() - state.windowStart >= WINDOW)) adminFailures.delete(ip);
  return null;
}
function recordFailure(ip) {
  const now = Date.now();
  const state = adminFailures.get(ip) || { count: 0, windowStart: now };
  state.count++;
  if (state.count >= 5) state.lockedUntil = now + WINDOW;
  adminFailures.set(ip, state);
}
setInterval(() => { for (const ip of adminFailures.keys()) locked(ip); }, WINDOW).unref();
function adminProtection(hasSession = () => false) {
  function authenticate(req, res, publicMedia) {
    const ip = clientIp(req);
    const minutes = locked(ip);
    if (minutes) {
      res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${minutes} minute(s).` });
      return null;
    }
    const password = req.headers['x-admin-password'];
    if (password !== undefined) {
      if (!isAdminPassword(password)) {
        recordFailure(ip);
        res.status(401).json({ success: false, message: 'Wrong password.' });
        return null;
      }
      adminFailures.delete(ip);
      return true;
    }
    if (hasSession(req)) { adminFailures.delete(ip); return true; }
    if (publicMedia) return false; // Anonymous visitors do not consume password attempts.
    if (!process.env.ADMIN_PASSWORD) {
      res.status(500).json({ success: false, message: 'ADMIN_PASSWORD is not configured.' });
    } else {
      recordFailure(ip);
      res.status(401).json({ success: false, message: 'Wrong password.' });
    }
    return null;
  }
  return {
    requireAdmin(req, res, next) { if (authenticate(req, res, false) === true) next(); },
    mediaAccess(req, res, next) {
      const access = authenticate(req, res, true);
      if (access !== null) { req.isMediaAdmin = access; next(); }
    },
  };
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
module.exports = { safeEqual, isAdminPassword, parseCookies, getReactorHash, ensureReactorIdentity, adminProtection, routeLimit, submissionGuard };
