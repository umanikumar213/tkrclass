const crypto = require('crypto');
const sharp = require('sharp');
const pool = require('../db');
const { SpotlightCache } = require('./spotlight-cache');
const { getContent } = require('./spotlight-settings');
const { generateAvatar } = require('./spotlight-avatars');

const hiddenRolls = new Set();
const photoCache = new SpotlightCache({ ttl: 604800000, max: 3000, bytes: 25 * 1024 * 1024 });
const ogCache = new SpotlightCache({ ttl: 604800000, max: 3000, bytes: 25 * 1024 * 1024 });
const avatarCache = new SpotlightCache({ ttl: 604800000, max: 3000, bytes: 25 * 1024 * 1024 });
const inFlight = new Map();
const genericCache = new SpotlightCache({ ttl: 300000, max: 1 });
let generation = 0;

async function initSpotlightMedia() {
  const { rows } = await pool.query('SELECT roll_number FROM spotlight_students WHERE hidden=TRUE');
  hiddenRolls.clear();
  for (const row of rows) hiddenRolls.add(row.roll_number);
  await genericImage();
}
async function genericImage() {
  const { texts } = await getContent();
  const title = texts.og_fallback_title;
  const cached = genericCache.get(title);
  if (cached !== undefined) return cached;
  const escaped = title.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const image = await sharp(Buffer.from(
    '<svg width="400" height="400"><rect width="400" height="400" fill="#4f46e5"/>' +
    '<circle cx="200" cy="132" r="48" fill="#ddd6fe"/>' +
    `<text x="200" y="245" text-anchor="middle" font-family="sans-serif" font-size="24" textLength="360" lengthAdjust="spacingAndGlyphs" fill="white">${escaped}</text></svg>`
  )).jpeg({ quality: 80 }).toBuffer();
  genericCache.set(title, image);
  return image;
}

function invalidateStudentMedia(roll, hidden) {
  generation++;
  if (hidden) hiddenRolls.add(roll); else hiddenRolls.delete(roll);
  photoCache.delete(roll);
  ogCache.delete(roll);
  avatarCache.delete(roll);
}

async function getAvatar(roll) {
  if (hiddenRolls.has(roll)) return null;
  const cached = avatarCache.get(roll);
  if (cached !== undefined) return cached;
  const version = generation;
  const key = `avatar:${roll}:${version}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const { rows } = await pool.query(
      'SELECT avatar_group FROM spotlight_students WHERE roll_number=$1 AND hidden=FALSE', [roll]);
    const svg = rows.length ? await generateAvatar(roll, rows[0].avatar_group) : null;
    if (hiddenRolls.has(roll)) return null;
    if (version !== generation) return getAvatar(roll);
    avatarCache.set(roll, svg);
    return svg;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

async function getPhoto(roll) {
  if (hiddenRolls.has(roll)) return null;
  const cached = photoCache.get(roll);
  if (cached !== undefined) return cached;
  const key = `photo:${roll}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const version = generation;
  const task = (async () => {
    const { rows } = await pool.query(
      'SELECT photo_data FROM spotlight_students WHERE roll_number=$1 AND hidden=FALSE', [roll]);
    const photo = rows[0]?.photo_data || null;
    if (version === generation && !hiddenRolls.has(roll)) photoCache.set(roll, photo);
    return hiddenRolls.has(roll) ? null : photo;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

async function getOg(roll) {
  const generic = await genericImage();
  if (hiddenRolls.has(roll)) return generic;
  const cached = ogCache.get(roll);
  if (cached !== undefined) return cached || generic;
  const version = generation;
  const key = `og:${roll}:${version}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const photo = await getPhoto(roll);
    const source = photo || await getAvatar(roll);
    const image = source ? await sharp(source).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer() : null;
    if (version !== generation && !hiddenRolls.has(roll)) return getOg(roll);
    if (version === generation && !hiddenRolls.has(roll)) ogCache.set(roll, image);
    return hiddenRolls.has(roll) ? generic : image || generic;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

function sendImage(req, res, data, type) {
  const etag = `"${crypto.createHash('sha256').update(data).digest('hex')}"`;
  res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable', ETag: etag });
  if ((req.get('If-None-Match') || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag)) {
    return res.status(304).end();
  }
  res.send(data);
}

module.exports = { hiddenRolls, initSpotlightMedia, invalidateStudentMedia, getPhoto, getAvatar, getOg, sendImage };
