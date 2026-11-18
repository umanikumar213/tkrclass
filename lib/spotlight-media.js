const crypto = require('crypto');
const sharp = require('sharp');
const pool = require('../db');
const { SpotlightCache } = require('./spotlight-cache');

const hiddenRolls = new Set();
const photoCache = new SpotlightCache({ ttl: 604800000, max: 3000, bytes: 25 * 1024 * 1024 });
const ogCache = new SpotlightCache({ ttl: 604800000, max: 3000, bytes: 25 * 1024 * 1024 });
const inFlight = new Map();
let generic;
let generation = 0;

async function initSpotlightMedia() {
  const { rows } = await pool.query('SELECT roll_number FROM spotlight_students WHERE hidden=TRUE');
  hiddenRolls.clear();
  for (const row of rows) hiddenRolls.add(row.roll_number);
  generic = await sharp(Buffer.from(
    '<svg width="400" height="400"><rect width="400" height="400" fill="#4f46e5"/>' +
    '<circle cx="200" cy="132" r="48" fill="#ddd6fe"/>' +
    '<text x="200" y="245" text-anchor="middle" font-family="sans-serif" font-size="32" fill="white">TKR Spotlight</text></svg>'
  )).jpeg({ quality: 80 }).toBuffer();
}

function invalidateStudentMedia(roll, hidden) {
  generation++;
  if (hidden) hiddenRolls.add(roll); else hiddenRolls.delete(roll);
  photoCache.delete(roll);
  ogCache.delete(roll);
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
  if (hiddenRolls.has(roll)) return generic;
  const cached = ogCache.get(roll);
  if (cached !== undefined) return cached || generic;
  const key = `og:${roll}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const version = generation;
  const task = (async () => {
    const photo = await getPhoto(roll);
    const image = photo ? await sharp(photo).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer() : null;
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

module.exports = { hiddenRolls, initSpotlightMedia, invalidateStudentMedia, getPhoto, getOg, sendImage };
