const crypto = require('crypto');
const { safeEqual, parseCookies, isAdminPassword } = require('../security');
const clientIp = require('./client-ip');

const ADMIN_SESSION_MS = 30 * 60 * 1000;
function signAdminSession(timestamp) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`reyi-admin:${timestamp}`).digest('base64url');
}
function hasAdminSession(req) {
  if (!process.env.SESSION_SECRET) return false;
  const token = parseCookies(req.headers.cookie).reyi_admin;
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const timestamp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(timestamp) || timestamp + ADMIN_SESSION_MS < Date.now()) return false;
  return safeEqual(token.slice(dot + 1), signAdminSession(timestamp));
}
function setAdminSession(req, res) {
  if (!process.env.SESSION_SECRET) return;
  const timestamp = Date.now();
  res.append('Set-Cookie', `reyi_admin=${timestamp}.${signAdminSession(timestamp)}; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}; Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`);
}
// One lockout across both boards, their admin endpoints, and protected media.
const adminFailures = new Map();
const WINDOW = 15 * 60 * 1000;
function locked(ip) {
  const state = adminFailures.get(ip);
  if (state?.lockedUntil > Date.now()) return Math.ceil((state.lockedUntil - Date.now()) / 60000);
  if (state && (state.lockedUntil || Date.now() - state.windowStart >= WINDOW)) adminFailures.delete(ip);
  return null;
}
function recordFailure(ip) {
  const state = adminFailures.get(ip) || { count: 0, windowStart: Date.now() };
  state.count++;
  if (state.count >= 5) state.lockedUntil = Date.now() + WINDOW;
  adminFailures.set(ip, state);
}
setInterval(() => { for (const ip of adminFailures.keys()) locked(ip); }, WINDOW).unref();
function adminProtection(hasSession = () => false) {
  function authenticate(req, res, publicMedia) {
    const ip = clientIp(req), minutes = locked(ip);
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
    if (publicMedia) return false;
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
module.exports = { adminProtection, clientIp, hasAdminSession, setAdminSession };
