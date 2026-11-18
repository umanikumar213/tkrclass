const crypto = require('crypto');
const axios = require('axios');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { clientIp } = require('./admin');
const { ensureReactorIdentity } = require('../security');

const turnstileEnabled = () => Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET);
function hashIp(req) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(clientIp(req)).digest('hex');
}
function identity(req, res, next) {
  if (!process.env.SESSION_SECRET) return res.status(503).json({ message: 'Visitor identity is not configured.' });
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
    message: { message: 'Too many requests. Please try again later.' },
  });
}
async function verifyTurnstile(req, res, next) {
  if (!turnstileEnabled()) return next();
  const token = req.body?.turnstileToken;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return res.status(400).json({ message: 'Please complete the security check.' });
  }
  try {
    const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: token });
    const { data } = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', form.toString(), {
      timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!data?.success) return res.status(400).json({ message: 'Security check failed. Please try again.' });
    next();
  } catch {
    res.status(503).json({ message: 'Security check is unavailable. Please try again.' });
  }
}
module.exports = { identity, spotlightLimit, verifyTurnstile, turnstileEnabled };
