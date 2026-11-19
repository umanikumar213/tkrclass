const crypto = require('crypto');
const axios = require('axios');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { clientIp } = require('./admin');
const { ensureReactorIdentity, parseCookies, safeEqual } = require('../security');
const { message } = require('./spotlight-settings');

const turnstileEnabled = () => Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET);
function hashIp(req) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(clientIp(req)).digest('hex');
}
function identity(req, res, next) {
  if (!process.env.SESSION_SECRET) return res.status(503).json({ message: message(req, 'identity_missing') });
  req.voterHash = ensureReactorIdentity(req, res);
  req.spotlightIp = hashIp(req);
  next();
}
function spotlightLimit(limit, windowMs) {
  return rateLimit({
    limit, windowMs, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => process.env.SESSION_SECRET
      ? crypto.createHmac('sha256', process.env.SESSION_SECRET).update(ipKeyGenerator(clientIp(req))).digest('hex')
      : 'unconfigured',
    handler: (req, res) => res.status(429).json({ message: message(req, 'rate_limit') }),
  });
}
function deviceHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return null;
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('hex');
}
function signature(purpose, voter, payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`spotlight:${purpose}:${voter}:${payload}`).digest('base64url');
}
function readSignedCookie(req, name, purpose, maxAge) {
  if (!req.voterHash || !process.env.SESSION_SECRET) return null;
  const token = parseCookies(req.headers.cookie)[name];
  if (!token || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const timestamp = Number(parts[0]);
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now() || timestamp + maxAge < Date.now()) return null;
  if (!safeEqual(parts[2], signature(purpose, req.voterHash, `${parts[0]}.${parts[1]}`))) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
function setSignedCookie(req, res, name, purpose, value, maxAge) {
  const payload = `${Date.now()}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  const token = `${payload}.${signature(purpose, req.voterHash, payload)}`;
  res.append('Set-Cookie', `${name}=${token}; Max-Age=${Math.floor(maxAge / 1000)}; Path=/api/spotlight; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`);
}
const DAY = 86400000;
const turnstileVerified = req => readSignedCookie(req, 'spotlight_verified', 'verified', DAY) === true;
async function verifyTurnstile(req, res, next) {
  if (!turnstileEnabled() || turnstileVerified(req)) return next();
  const token = req.body?.turnstileToken;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return res.status(400).json({ message: message(req, 'security_required') });
  }
  try {
    const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: token });
    const { data } = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', form.toString(), {
      timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!data?.success) return res.status(400).json({ message: message(req, 'security_failed') });
    setSignedCookie(req, res, 'spotlight_verified', 'verified', true, DAY);
    next();
  } catch {
    res.status(503).json({ message: message(req, 'security_unavailable') });
  }
}
module.exports = {
  identity, spotlightLimit, verifyTurnstile, turnstileEnabled, turnstileVerified,
  readSignedCookie, setSignedCookie, deviceHash,
};
