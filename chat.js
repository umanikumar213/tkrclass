const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');

const CHAT_MOODS = new Set([
  'Heartache',
  'Nostalgia',
  'Goosebumps',
  'Midnight Thoughts',
  'Alone',
  'Other / Casual',
]);
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'chat-uploads');
const TELEGRAM_FILE_PATH_CACHE_MS = 60 * 60 * 1000;
const STALE_UPLOAD_MS = 60 * 60 * 1000;
const telegramFilePathCache = new Map();

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true, mode: 0o700 });

async function sweepStaleUploads() {
  const entries = await fs.promises.readdir(TEMP_UPLOAD_DIR, { withFileTypes: true });
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const filePath = path.join(TEMP_UPLOAD_DIR, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(filePath).catch(() => {});
  }));
}
sweepStaleUploads().catch(error => console.error('[chat] stale upload cleanup error:', error.message));
setInterval(() => {
  sweepStaleUploads().catch(error => console.error('[chat] stale upload cleanup error:', error.message));
}, 30 * 60 * 1000).unref();

// --- feed cache (5-minute TTL, invalidated immediately on admin actions) ---
const FEED_CACHE_TTL = 300_000; // 300 seconds in ms
const feedCache = new Map();    // key → { data, expiresAt }
function invalidateFeedCache() { feedCache.clear(); }
function getFeedCache(key) {
  const entry = feedCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { feedCache.delete(key); return null; }
  return entry.data;
}
function setFeedCache(key, data) {
  feedCache.set(key, { data, expiresAt: Date.now() + FEED_CACHE_TTL });
}

// Railway (and most hosted PG) require SSL; Replit dev works without it.
// rejectUnauthorized:false handles self-signed certs on Railway's internal PG.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confessions (
      id          SERIAL PRIMARY KEY,
      post_number INTEGER UNIQUE,
      text        VARCHAR(2500) NOT NULL,
      image_data  BYTEA,
      image_type  TEXT,
      video_file_id TEXT,
      mood        TEXT NOT NULL DEFAULT 'Other / Casual',
      status      TEXT NOT NULL DEFAULT 'pending',
      reported    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS confession_counter (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT INTO confession_counter (name, value) VALUES ('post_number', 0)
      ON CONFLICT (name) DO NOTHING;
  `);
  // Add reaction columns to existing DB (safe: IF NOT EXISTS is idempotent)
  await pool.query(`
    ALTER TABLE confessions
      ADD COLUMN IF NOT EXISTS react_heart INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_laugh INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_wow   INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_sad   INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_fire  INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_up    INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE confessions
      ALTER COLUMN text TYPE VARCHAR(2500),
      ADD COLUMN IF NOT EXISTS video_file_id TEXT,
      ADD COLUMN IF NOT EXISTS mood TEXT NOT NULL DEFAULT 'Other / Casual';
    CREATE INDEX IF NOT EXISTS idx_confessions_mood_approved
      ON confessions (mood, post_number DESC) WHERE status = 'approved';
  `);
  // Comments table – cascades with the parent post
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confession_comments (
      id            SERIAL PRIMARY KEY,
      confession_id INTEGER NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
      text          VARCHAR(280) NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON confession_comments(confession_id);
  `);
  console.log('[chat] DB schema ready');
}
const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
  }),
  limits: { fileSize: VIDEO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const validImage = file.fieldname === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    const validVideo = file.fieldname === 'video' && file.mimetype === 'video/mp4';
    cb(validImage || validVideo ? null : new Error('Use a JPG, PNG, WebP, or MP4 file.'), validImage || validVideo);
  }
});

function uploadedFiles(req) {
  return Object.values(req.files || {}).flat();
}

async function removeTemporaryUploads(req) {
  await Promise.all(uploadedFiles(req).map(file => fs.promises.unlink(file.path).catch(() => {})));
}

async function compressImage(file) {
  if (!file) return { data: null, type: null };
  const input = await fs.promises.readFile(file.path);
  const resize = { width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true };
  if (file.mimetype === 'image/png') {
    return { data: await sharp(input).rotate().resize(resize).png({ quality: 75, compressionLevel: 8 }).toBuffer(), type: 'image/png' };
  }
  if (file.mimetype === 'image/webp') {
    return { data: await sharp(input).rotate().resize(resize).webp({ quality: 75 }).toBuffer(), type: 'image/webp' };
  }
  return { data: await sharp(input).rotate().resize(resize).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), type: 'image/jpeg' };
}

async function readMp4Box(handle, offset, end) {
  if (offset + 8 > end) return null;
  const header = Buffer.alloc(16);
  const { bytesRead } = await handle.read(header, 0, 16, offset);
  if (bytesRead < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.subarray(4, 8).toString('ascii');
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    const extended = header.readBigUInt64BE(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) return null;
  return { type, offset, size, headerSize, contentStart: offset + headerSize, end: offset + size };
}

async function mp4TrackIsVideo(handle, track, boxBudget) {
  let trackOffset = track.contentStart;
  while (trackOffset < track.end && boxBudget.count++ < 10_000) {
    const child = await readMp4Box(handle, trackOffset, track.end);
    if (!child) return false;
    if (child.type === 'mdia') {
      let mediaOffset = child.contentStart;
      while (mediaOffset < child.end && boxBudget.count++ < 10_000) {
        const mediaChild = await readMp4Box(handle, mediaOffset, child.end);
        if (!mediaChild) return false;
        if (mediaChild.type === 'hdlr' && mediaChild.contentStart + 12 <= mediaChild.end) {
          const payload = Buffer.alloc(12);
          const { bytesRead } = await handle.read(payload, 0, 12, mediaChild.contentStart);
          return bytesRead === 12 && payload.subarray(8, 12).toString('ascii') === 'vide';
        }
        mediaOffset = mediaChild.end;
      }
    }
    trackOffset = child.end;
  }
  return false;
}

async function validateMp4(file) {
  const invalid = () => {
    const error = new Error('Use a valid MP4 video.');
    error.code = 'INVALID_VIDEO';
    return error;
  };
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const stat = await handle.stat();
    let offset = 0;
    let validBrand = false;
    let hasVideoTrack = false;
    const boxBudget = { count: 0 };
    while (offset < stat.size && boxBudget.count++ < 10_000) {
      const box = await readMp4Box(handle, offset, stat.size);
      if (!box) throw invalid();
      if (box.type === 'ftyp') {
        const brandLength = Math.min(box.size - box.headerSize, 256);
        if (brandLength < 8) throw invalid();
        const brandsBuffer = Buffer.alloc(brandLength);
        const { bytesRead } = await handle.read(brandsBuffer, 0, brandLength, box.contentStart);
        if (bytesRead !== brandLength) throw invalid();
        const brands = [];
        brands.push(brandsBuffer.subarray(0, 4).toString('ascii'));
        for (let index = 8; index + 4 <= brandLength; index += 4) {
          brands.push(brandsBuffer.subarray(index, index + 4).toString('ascii'));
        }
        validBrand = brands.some(brand =>
          /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|F4V )$/.test(brand)
        ) && !brands.includes('qt  ');
      } else if (box.type === 'moov') {
        let childOffset = box.contentStart;
        while (childOffset < box.end && boxBudget.count++ < 10_000) {
          const child = await readMp4Box(handle, childOffset, box.end);
          if (!child) throw invalid();
          if (child.type === 'trak' && await mp4TrackIsVideo(handle, child, boxBudget)) {
            hasVideoTrack = true;
            break;
          }
          childOffset = child.end;
        }
      }
      if (validBrand && hasVideoTrack) return;
      offset = box.end;
    }
    throw invalid();
  } catch (error) {
    if (error.code === 'INVALID_VIDEO') throw error;
    throw invalid();
  } finally {
    await handle.close();
  }
}

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Telegram video storage is not configured.');
  return { token, channelId };
}

async function sendVideoToTelegram(file) {
  const { token, channelId } = telegramConfig();
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('video', fs.createReadStream(file.path), {
    filename: path.basename(file.originalname || file.filename),
    contentType: file.mimetype,
  });
  form.append('supports_streaming', 'true');
  const response = await axios.post(`https://api.telegram.org/bot${token}/sendVideo`, form, {
    headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 90_000,
  });
  const fileId = response.data?.result?.video?.file_id;
  if (!response.data?.ok || !fileId) throw new Error('Telegram did not return a video file ID.');
  return fileId;
}

async function telegramFilePath(fileId) {
  const cached = telegramFilePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return cached.filePath;
  if (cached) telegramFilePathCache.delete(fileId);
  const { token } = telegramConfig();
  const response = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
    params: { file_id: fileId }, timeout: 20_000,
  });
  const filePath = response.data?.result?.file_path;
  if (!response.data?.ok || !filePath) throw new Error('Telegram could not resolve this video.');
  telegramFilePathCache.set(fileId, { filePath, expiresAt: Date.now() + TELEGRAM_FILE_PATH_CACHE_MS });
  return filePath;
}

// --- rate limit: 1 post per 3 minutes per IP ---
const lastPost = new Map();
const RATE_MS = 3 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_MS;
  for (const [ip, t] of lastPost) if (t < cutoff) lastPost.delete(ip);
}, 10 * 60 * 1000).unref();

// req.ip respects Express "trust proxy" (set in server.js) and cannot be spoofed via arbitrary headers
const clientIp = req => req.ip || req.socket.remoteAddress || 'unknown';

// --- admin brute-force protection ---
// Tracks { count, lockedUntil } per IP for failed admin auth attempts.
const adminFailures = new Map();
const ADMIN_MAX_ATTEMPTS = 5;          // failed attempts before lockout
const ADMIN_LOCKOUT_MS  = 15 * 60 * 1000; // 15-minute lockout window
const ADMIN_WINDOW_MS   = 15 * 60 * 1000; // rolling window for attempt counting

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of adminFailures) {
    if (state.lockedUntil && now > state.lockedUntil) adminFailures.delete(ip);
    else if (!state.lockedUntil && now > state.windowStart + ADMIN_WINDOW_MS) adminFailures.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function recordAdminFailure(ip) {
  const now = Date.now();
  const state = adminFailures.get(ip) || { count: 0, windowStart: now, lockedUntil: null };
  // Reset count if outside the rolling window (and not currently locked out)
  if (!state.lockedUntil && now > state.windowStart + ADMIN_WINDOW_MS) {
    state.count = 0;
    state.windowStart = now;
  }
  state.count += 1;
  if (state.count >= ADMIN_MAX_ATTEMPTS) {
    state.lockedUntil = now + ADMIN_LOCKOUT_MS;
    console.warn(`[admin] IP ${ip} locked out after ${state.count} failed attempts.`);
  } else {
    console.warn(`[admin] Failed attempt ${state.count}/${ADMIN_MAX_ATTEMPTS} from IP ${ip}.`);
  }
  adminFailures.set(ip, state);
}

function checkAdminLockout(ip) {
  const state = adminFailures.get(ip);
  if (!state || !state.lockedUntil) return null;
  const remaining = state.lockedUntil - Date.now();
  if (remaining <= 0) { adminFailures.delete(ip); return null; }
  return Math.ceil(remaining / 60000); // minutes remaining
}

// --- admin auth ---
function requireAdmin(req, res, next) {
  const ip = clientIp(req);
  const lockedMinutes = checkAdminLockout(ip);
  if (lockedMinutes !== null) {
    return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${lockedMinutes} minute(s).` });
  }
  const pass = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ success: false, message: 'ADMIN_PASSWORD is not configured.' });
  if (pass !== process.env.ADMIN_PASSWORD) {
    recordAdminFailure(ip);
    return res.status(401).json({ success: false, message: 'Wrong password.' });
  }
  next();
}

// --- pages ---
router.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
router.get('/chat/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat-admin.html')));

// --- public API ---
router.post('/api/chat/posts', (req, res) => {
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      await removeTemporaryUploads(req);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? (err.field === 'image' ? 'Image must be under 5MB.' : 'Videos must be 20MB or smaller.')
        : err.message;
      return res.status(400).json({ success: false, message: msg });
    }
    const cleanupOnAbort = () => { removeTemporaryUploads(req).catch(() => {}); };
    req.once('aborted', cleanupOnAbort);
    res.once('close', () => { if (!res.writableEnded) cleanupOnAbort(); });
    try {
      const ip = clientIp(req);
      const last = lastPost.get(ip);
      if (last && Date.now() - last < RATE_MS) {
        const wait = Math.ceil((RATE_MS - (Date.now() - last)) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${Math.ceil(wait / 60)} minute(s) before posting again.` });
      }
      const text = (req.body.text || '').trim();
      if (!text) return res.status(400).json({ success: false, message: 'Confession text is required.' });
      if (text.length > 2500) return res.status(400).json({ success: false, message: 'Max 2500 characters.' });
      const mood = String(req.body.mood || '');
      if (!CHAT_MOODS.has(mood)) return res.status(400).json({ success: false, message: 'Choose a valid mood.' });

      const image = req.files?.image?.[0] || null;
      const video = req.files?.video?.[0] || null;
      if (image && video) return res.status(400).json({ success: false, message: 'Choose either an image or a video.' });
      if (image && image.size > IMAGE_MAX_BYTES) return res.status(400).json({ success: false, message: 'Image must be under 5MB.' });
      const { data: imageData, type: imageType } = await compressImage(image);
      if (video) await validateMp4(video);
      const videoFileId = video ? await sendVideoToTelegram(video) : null;

      await pool.query(
        `INSERT INTO confessions (text, image_data, image_type, video_file_id, mood, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [text, imageData, imageType, videoFileId, mood]
      );
      lastPost.set(ip, Date.now());
      res.json({ success: true, message: 'Your post has been submitted for approval. It will appear once an admin approves it.' });
    } catch (e) {
      console.error('post submit error:', e.message);
      if (e.code === 'INVALID_VIDEO') {
        res.status(400).json({ success: false, message: e.message });
      } else {
        const message = e.message === 'Telegram video storage is not configured.'
          ? 'Telegram video uploads are not configured.'
          : 'Something went wrong. Please try again.';
        res.status(500).json({ success: false, message });
      }
    } finally {
      await removeTemporaryUploads(req);
    }
  });
});

router.get('/api/chat/posts', async (req, res) => {
  try {
    const PAGE_SIZE = 10;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const mood = CHAT_MOODS.has(req.query.mood) ? req.query.mood : '';

    const cacheKey = `p${page}|m${mood || 'all'}`;
    const cached = getFeedCache(cacheKey);
    if (cached) return res.json(cached);

    const offset = (page - 1) * PAGE_SIZE;
    const params = [];
    let where = `status = 'approved'`;
    if (mood) { params.push(mood); where += ` AND mood = $1`; }

    const { rows } = await pool.query(
      `SELECT id, post_number, text, mood, (image_data IS NOT NULL) AS has_image,
              (video_file_id IS NOT NULL) AS has_video, video_file_id, created_at,
              react_heart, react_laugh, react_wow, react_sad, react_fire, react_up,
              (SELECT COUNT(*) FROM confession_comments cc
               WHERE cc.confession_id = confessions.id AND cc.status = 'approved') AS comment_count
       FROM confessions WHERE ${where} ORDER BY post_number DESC
       LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
      params);
    const hasMore = rows.length > PAGE_SIZE;
    const payload = { success: true, posts: rows.slice(0, PAGE_SIZE), hasMore, page };
    setFeedCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error('feed error:', e.message);
    res.status(500).json({ success: false, message: 'Could not load posts.' });
  }
});

router.get('/api/chat/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).end();
    const { rows } = await pool.query(`SELECT image_data, image_type, status FROM confessions WHERE id = $1`, [id]);
    if (!rows.length || !rows[0].image_data) return res.status(404).end();
    // pending images only visible to admin; fail closed if ADMIN_PASSWORD is unset
    if (rows[0].status !== 'approved' &&
        (!process.env.ADMIN_PASSWORD || req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)) {
      return res.status(404).end();
    }
    res.set('Content-Type', rows[0].image_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(rows[0].image_data);
  } catch { res.status(500).end(); }
});

router.get('/api/chat/stream/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId || '');
    if (!fileId || fileId.length > 512) return res.status(400).end();
    const { rows } = await pool.query(
      `SELECT status FROM confessions WHERE video_file_id = $1`,
      [fileId]
    );
    const isAdmin = Boolean(process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD);
    if (!rows.length || (rows[0].status !== 'approved' && !isAdmin)) return res.status(404).end();

    const { token } = telegramConfig();
    const filePath = await telegramFilePath(fileId);
    const upstream = await axios.get(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      responseType: 'stream',
      headers: req.headers.range ? { Range: req.headers.range } : undefined,
      timeout: 30_000,
      validateStatus: code => code === 200 || code === 206,
    });
    res.status(upstream.status);
    res.set('Content-Type', 'video/mp4');
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=300');
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.set('Content-Range', upstream.headers['content-range']);
    upstream.data.on('error', error => {
      console.error('[chat] video stream error:', error.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    upstream.data.pipe(res);
  } catch (error) {
    console.error('[chat] stream error:', error.message);
    if (!res.headersSent) res.status(502).end();
  }
});

const VALID_EMOJIS = new Set(['heart','laugh','wow','sad','fire','up']);
router.post('/api/chat/posts/:id/react', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const { emoji, prev } = req.body; // emoji = new (null = remove), prev = old (null = none)
    if (emoji != null && !VALID_EMOJIS.has(emoji)) return res.status(400).json({ success: false });
    if (prev  != null && !VALID_EMOJIS.has(prev))  return res.status(400).json({ success: false });
    const sets = [];
    if (prev != null) sets.push(`react_${prev} = GREATEST(0, react_${prev} - 1)`);
    if (emoji != null) sets.push(`react_${emoji} = react_${emoji} + 1`);
    if (!sets.length) return res.json({ success: true });
    const result = await pool.query(
      `UPDATE confessions SET ${sets.join(', ')} WHERE id = $1 AND status = 'approved'
       RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ success: false });
    invalidateFeedCache();
    res.json({ success: true });
  } catch (e) {
    console.error('react error:', e.message);
    res.status(500).json({ success: false });
  }
});

router.post('/api/chat/posts/:id/report', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE confessions SET reported = TRUE WHERE id = $1 AND status = 'approved'`, [id]);
    res.json({ success: true, message: 'Reported. An admin will review this post.' });
  } catch { res.status(500).json({ success: false }); }
});

// --- comments (public) ---
const lastComment = new Map();
const COMMENT_RATE_MS = 60_000; // 1 comment per minute per IP

router.get('/api/chat/posts/:id/comments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const { rows } = await pool.query(
      `SELECT id, text, created_at FROM confession_comments
       WHERE confession_id = $1 AND status = 'approved' ORDER BY created_at ASC`, [id]);
    res.json({ success: true, comments: rows });
  } catch { res.status(500).json({ success: false }); }
});

router.post('/api/chat/posts/:id/comments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const ip = clientIp(req);
    const last = lastComment.get(ip);
    if (last && Date.now() - last < COMMENT_RATE_MS) {
      const wait = Math.ceil((COMMENT_RATE_MS - (Date.now() - last)) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${wait}s before commenting again.` });
    }
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'Comment cannot be empty.' });
    if (text.length > 280) return res.status(400).json({ success: false, message: 'Max 280 characters.' });
    const check = await pool.query(`SELECT id FROM confessions WHERE id = $1 AND status = 'approved'`, [id]);
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Post not found.' });
    await pool.query(`INSERT INTO confession_comments (confession_id, text) VALUES ($1, $2)`, [id, text]);
    lastComment.set(ip, Date.now());
    res.json({ success: true, message: 'Comment submitted for approval.' });
  } catch (e) {
    console.error('comment submit error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

// --- admin API ---
router.post('/api/chat/admin/login', requireAdmin, (req, res) => res.json({ success: true }));

router.get('/api/chat/admin/queue', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, post_number, text, mood, (image_data IS NOT NULL) AS has_image,
              (video_file_id IS NOT NULL) AS has_video, video_file_id, status, reported, created_at
       FROM confessions WHERE status = 'pending' OR reported = TRUE ORDER BY created_at ASC`);
    res.json({ success: true, posts: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load queue.' });
  }
});

router.post('/api/chat/admin/approve/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await client.query('BEGIN');
    const check = await client.query(`SELECT status FROM confessions WHERE id = $1 FOR UPDATE`, [id]);
    if (!check.rows.length || check.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Post is not pending.' });
    }
    const c = await client.query(`UPDATE confession_counter SET value = value + 1 WHERE name = 'post_number' RETURNING value`);
    const num = c.rows[0].value;
    await client.query(`UPDATE confessions SET status = 'approved', post_number = $1 WHERE id = $2`, [num, id]);
    await client.query('COMMIT');
    invalidateFeedCache();
    res.json({ success: true, postNumber: num });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('approve error:', e.message);
    res.status(500).json({ success: false, message: 'Approve failed.' });
  } finally { client.release(); }
});

// reject (pending) or delete (reported/approved): permanently removes everything
router.post('/api/chat/admin/reject/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`DELETE FROM confessions WHERE id = $1`, [id]);
    invalidateFeedCache();
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Delete failed.' }); }
});

router.post('/api/chat/admin/unflag/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE confessions SET reported = FALSE WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

// --- admin comment review ---
router.get('/api/chat/admin/comments-queue', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cc.id, cc.text, cc.created_at,
              c.text AS post_text, c.post_number
       FROM confession_comments cc
       JOIN confessions c ON c.id = cc.confession_id
       WHERE cc.status = 'pending' ORDER BY cc.created_at ASC`);
    res.json({ success: true, comments: rows });
  } catch { res.status(500).json({ success: false }); }
});

router.post('/api/chat/admin/approve-comment/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE confession_comments SET status = 'approved' WHERE id = $1`, [id]);
    invalidateFeedCache(); // comment_count in feed changes
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Approve failed.' }); }
});

router.post('/api/chat/admin/reject-comment/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`DELETE FROM confession_comments WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Reject failed.' }); }
});

router.initDb = initDb;
module.exports = router;
