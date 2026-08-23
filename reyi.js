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

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const CATEGORIES = new Set(['Heartache', 'Nostalgia', 'Goosebumps', 'Midnight Thoughts', 'Alone', 'Healing']);
const REACTIONS = new Set(['heartache', 'pleading', 'goosebumps', 'hug', 'healing']);
const REYI_PAGE_SIZE = 10;
const REYI_CACHE_TTL = 300_000;
const feedCache = new Map();
const lastSubmission = new Map();
const lastComment = new Map();
const reactionWindows = new Map();
const adminFailures = new Map();
const SUBMISSION_RATE_MS = 10 * 60 * 1000;
const COMMENT_RATE_MS = 60 * 1000;
const REACTION_WINDOW_MS = 60 * 1000;
const REACTION_MAX_PER_WINDOW = 30;
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_SESSION_MS = 30 * 60 * 1000;
const TELEGRAM_FILE_PATH_CACHE_MS = 60 * 60 * 1000;
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const STORY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'reyi-uploads');
const telegramFilePathCache = new Map();

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true, mode: 0o700 });
const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
  }),
  limits: { fileSize: VIDEO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const validStoryImage = file.fieldname === 'story_image' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    const validVideo = file.fieldname === 'video' && ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.mimetype);
    cb(validStoryImage || validVideo ? null : new Error('Use a JPG, PNG, WebP, MP4, WebM, or MOV file.'), validStoryImage || validVideo);
  },
});

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function invalidateFeedCache() {
  feedCache.clear();
}

function getCachedFeed(key) {
  const entry = feedCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    feedCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedFeed(key, payload) {
  feedCache.set(key, { payload, expiresAt: Date.now() + REYI_CACHE_TTL });
}

function getIstClock(now = new Date()) {
  const values = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function getReyiStatus() {
  const ist = getIstClock();
  const open = ist.hour >= 23 || ist.hour < 5;
  const nextOpenAt = open
    ? null
    : new Date(Date.UTC(ist.year, ist.month - 1, ist.day, 17, 30, 0)).toISOString();
  return {
    open,
    dawn: open && ist.hour === 4 && ist.minute >= 50,
    nextOpenAt,
  };
}

function requireReyiOpen(req, res, next) {
  const status = getReyiStatus();
  if (!status.open) {
    return res.status(403).json({
      success: false,
      locked: true,
      message: 'Reyi opens at 11:00 PM IST.',
      ...status,
    });
  }
  req.reyiStatus = status;
  next();
}

function requireAdmin(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const current = adminFailures.get(ip);
  if (current && current.lockedUntil && current.lockedUntil > now) {
    const minutes = Math.ceil((current.lockedUntil - now) / 60000);
    return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${minutes} minute(s).` });
  }
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, message: 'ADMIN_PASSWORD is not configured.' });
  }
  if (!hasAdminAccess(req)) {
    const state = current && now - current.windowStart < ADMIN_WINDOW_MS
      ? current
      : { count: 0, windowStart: now, lockedUntil: null };
    state.count += 1;
    if (state.count >= ADMIN_MAX_ATTEMPTS) state.lockedUntil = now + ADMIN_LOCKOUT_MS;
    adminFailures.set(ip, state);
    return res.status(401).json({ success: false, message: 'Wrong password.' });
  }
  adminFailures.delete(ip);
  next();
}

function parseCookies(header) {
  const cookies = {};
  for (const pair of String(header || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return cookies;
}

function signVisitor(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(id).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
  const signature = token.slice(dot + 1);
  if (!Number.isSafeInteger(timestamp) || timestamp + ADMIN_SESSION_MS < Date.now()) return false;
  return safeEqual(signature, signAdminSession(timestamp));
}

function hasAdminAccess(req) {
  return Boolean(
    (process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD)
    || hasAdminSession(req)
  );
}

function setAdminSession(req, res) {
  if (!process.env.SESSION_SECRET) return;
  const timestamp = Date.now();
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `reyi_admin=${timestamp}.${signAdminSession(timestamp)}; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

function getReactorHash(req) {
  if (!process.env.SESSION_SECRET) return null;
  const token = parseCookies(req.headers.cookie).reyi_visitor;
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, signVisitor(id))) return null;
  return crypto.createHash('sha256').update(id).digest('hex');
}

function ensureReactorIdentity(req, res) {
  const existing = getReactorHash(req);
  if (existing || !process.env.SESSION_SECRET) return existing;
  const id = crypto.randomUUID();
  const signed = `${id}.${signVisitor(id)}`;
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `reyi_visitor=${encodeURIComponent(signed)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return crypto.createHash('sha256').update(id).digest('hex');
}

function consumeReactionRate(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let state = reactionWindows.get(ip);
  if (!state || now - state.startedAt >= REACTION_WINDOW_MS) {
    state = { startedAt: now, count: 0 };
  }
  state.count += 1;
  reactionWindows.set(ip, state);
  return state.count <= REACTION_MAX_PER_WINDOW;
}

async function compressStoryImage(file) {
  if (!file) return { data: null, type: null };
  const input = file.buffer || await fs.promises.readFile(file.path);
  const resize = { width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true };
  if (file.mimetype === 'image/png') {
    return { data: await sharp(input).rotate().resize(resize).png({ quality: 75, compressionLevel: 8 }).toBuffer(), type: 'image/png' };
  }
  if (file.mimetype === 'image/webp') {
    return { data: await sharp(input).rotate().resize(resize).webp({ quality: 75 }).toBuffer(), type: 'image/webp' };
  }
  return { data: await sharp(input).rotate().resize(resize).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), type: 'image/jpeg' };
}

function uploadedFiles(req) {
  return Object.values(req.files || {}).flat();
}

async function removeTemporaryUploads(req) {
  await Promise.all(uploadedFiles(req).map(file => fs.promises.unlink(file.path).catch(() => {})));
}

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error('Telegram video storage is not configured.');
  }
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
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 90_000,
  });
  const fileId = response.data?.result?.video?.file_id || response.data?.result?.document?.file_id;
  if (!response.data?.ok || !fileId) throw new Error('Telegram did not return a video file ID.');
  return fileId;
}

async function telegramFilePath(fileId) {
  const cached = telegramFilePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return cached.filePath;
  if (cached) telegramFilePathCache.delete(fileId);

  const { token } = telegramConfig();
  const response = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
    params: { file_id: fileId },
    timeout: 20_000,
  });
  const filePath = response.data?.result?.file_path;
  if (!response.data?.ok || !filePath) throw new Error('Telegram could not resolve this video.');
  telegramFilePathCache.set(fileId, { filePath, expiresAt: Date.now() + TELEGRAM_FILE_PATH_CACHE_MS });
  return filePath;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of reactionWindows) {
    if (now - state.startedAt > REACTION_WINDOW_MS * 2) reactionWindows.delete(ip);
  }
  for (const [ip, timestamp] of lastComment) {
    if (now - timestamp > COMMENT_RATE_MS * 2) lastComment.delete(ip);
  }
  for (const [ip, state] of adminFailures) {
    if ((state.lockedUntil && state.lockedUntil <= now) || now - state.windowStart > ADMIN_WINDOW_MS + ADMIN_LOCKOUT_MS) {
      adminFailures.delete(ip);
    }
  }
  for (const [fileId, entry] of telegramFilePathCache) {
    if (entry.expiresAt <= now) telegramFilePathCache.delete(fileId);
  }
}, 10 * 60 * 1000).unref();

async function initReyiDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reyi_posts (
      id                 SERIAL PRIMARY KEY,
      post_number        INTEGER UNIQUE,
      post_type          TEXT NOT NULL CHECK (post_type IN ('video', 'story')),
      telegram_file_id   TEXT,
      story_text         VARCHAR(2000),
      story_image_data   BYTEA,
      story_image_type   TEXT,
      category           VARCHAR(60) NOT NULL,
      caption            VARCHAR(150),
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      approved_at        TIMESTAMPTZ,
       expires_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       react_heartache    INTEGER NOT NULL DEFAULT 0,
       react_pleading     INTEGER NOT NULL DEFAULT 0,
       react_goosebumps   INTEGER NOT NULL DEFAULT 0,
       react_hug          INTEGER NOT NULL DEFAULT 0,
       react_healing      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reyi_counter (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reyi_reactions (
      post_id       INTEGER NOT NULL REFERENCES reyi_posts(id) ON DELETE CASCADE,
      reactor_hash  VARCHAR(64) NOT NULL,
      emoji         VARCHAR(20) NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, reactor_hash)
    );
    CREATE TABLE IF NOT EXISTS reyi_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES reyi_posts(id) ON DELETE CASCADE,
      text       VARCHAR(280) NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO reyi_counter (name, value) VALUES ('post_number', 0)
      ON CONFLICT (name) DO NOTHING;
    CREATE INDEX IF NOT EXISTS idx_reyi_posts_feed
      ON reyi_posts (status, category, post_number DESC);
    CREATE INDEX IF NOT EXISTS idx_reyi_comments_post
      ON reyi_comments (post_id);
  `);
  await pool.query(`
    ALTER TABLE reyi_posts
      ADD COLUMN IF NOT EXISTS react_heartache INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_pleading INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_goosebumps INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_hug INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS react_healing INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
    UPDATE reyi_posts
    SET category = CASE category
      WHEN 'Heartbreak' THEN 'Heartache'
      WHEN 'Inspiration' THEN 'Healing'
      WHEN 'Deep Thoughts' THEN 'Midnight Thoughts'
      WHEN 'Late Night Vibe' THEN 'Alone'
      ELSE category
    END
    WHERE category IN ('Heartbreak', 'Inspiration', 'Deep Thoughts', 'Late Night Vibe');
    UPDATE reyi_posts SET expires_at = NULL WHERE expires_at IS NOT NULL;
    DELETE FROM reyi_reactions
    WHERE emoji NOT IN ('heartache', 'pleading', 'goosebumps', 'hug', 'healing');
  `);
  console.log('[reyi] DB schema ready');
}

router.get('/reyi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi.html')));
router.get('/reyi/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi-admin.html')));

router.get('/api/reyi/status', (req, res) => {
  ensureReactorIdentity(req, res);
  res.json({ success: true, ...getReyiStatus() });
});

router.post('/api/reyi/posts', requireReyiOpen, (req, res) => {
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'story_image', maxCount: 1 }])(req, res, async err => {
    if (err) {
      await removeTemporaryUploads(req);
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Videos must be 20MB or smaller.' : err.message;
      return res.status(400).json({ success: false, message });
    }
    try {
      const ip = clientIp(req);
      const last = lastSubmission.get(ip);
      if (last && Date.now() - last < SUBMISSION_RATE_MS) {
        const remaining = Math.ceil((SUBMISSION_RATE_MS - (Date.now() - last)) / 60000);
        return res.status(429).json({ success: false, message: `Please wait ${remaining} minute(s) before submitting again.` });
      }

      const postType = String(req.body.post_type || '');
      const category = String(req.body.category || '');
      const caption = String(req.body.caption || '').trim();
      if (!['video', 'story'].includes(postType)) {
        return res.status(400).json({ success: false, message: 'Choose a video or story.' });
      }
      if (!CATEGORIES.has(category)) {
        return res.status(400).json({ success: false, message: 'Choose a valid category.' });
      }
      if (caption.length > 150) {
        return res.status(400).json({ success: false, message: 'Caption must be 150 characters or fewer.' });
      }

      let telegramFileId = null;
      let storyText = null;
      let imageData = null;
      let imageType = null;
      const videoFile = req.files?.video?.[0] || null;
      const storyImage = req.files?.story_image?.[0] || null;

      if (postType === 'video') {
        if (storyImage || !videoFile) {
          return res.status(400).json({ success: false, message: 'Choose an MP4, WebM, or MOV video file.' });
        }
        telegramFileId = await sendVideoToTelegram(videoFile);
      } else {
        if (videoFile) return res.status(400).json({ success: false, message: 'Videos can only be attached to video posts.' });
        if (storyImage && storyImage.size > STORY_IMAGE_MAX_BYTES) {
          return res.status(400).json({ success: false, message: 'Images must be 5MB or smaller.' });
        }
        storyText = String(req.body.story_text || '').trim();
        if (!storyText) return res.status(400).json({ success: false, message: 'Write your story first.' });
        if (storyText.length > 2000) return res.status(400).json({ success: false, message: 'Stories must be 2000 characters or fewer.' });
        ({ data: imageData, type: imageType } = await compressStoryImage(storyImage));
      }

      await pool.query(
        `INSERT INTO reyi_posts
          (post_type, telegram_file_id, story_text, story_image_data, story_image_type, category, caption)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [postType, telegramFileId, storyText, imageData, imageType, category, caption || null]
      );
      lastSubmission.set(ip, Date.now());
      res.json({ success: true, message: 'Sent.' });
    } catch (error) {
      console.error('[reyi] submission error:', error.message);
      const message = error.message === 'Telegram video storage is not configured.'
        ? 'Telegram video uploads are not configured.'
        : 'Could not submit right now.';
      res.status(500).json({ success: false, message });
    } finally {
      await removeTemporaryUploads(req);
    }
  });
});

router.get('/api/reyi/posts', requireReyiOpen, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const category = CATEGORIES.has(req.query.category) ? req.query.category : '';
    const cacheKey = `p${page}|c${category || 'all'}`;
    const cached = getCachedFeed(cacheKey);
    if (cached) return res.json(cached);

    const offset = (page - 1) * REYI_PAGE_SIZE;
    const values = [];
    let where = `status = 'approved' AND (post_type = 'story' OR telegram_file_id IS NOT NULL)`;
    if (category) {
      values.push(category);
      where += ` AND category = $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, post_number, post_type, telegram_file_id, story_text,
               (story_image_data IS NOT NULL) AS has_story_image, category, caption, created_at,
               react_heartache, react_pleading, react_goosebumps, react_hug, react_healing,
               (SELECT COUNT(*) FROM reyi_comments rc
                WHERE rc.post_id = reyi_posts.id AND rc.status = 'approved') AS comment_count
       FROM reyi_posts
       WHERE ${where}
       ORDER BY post_number DESC
       LIMIT ${REYI_PAGE_SIZE + 1} OFFSET ${offset}`,
      values
    );
    const payload = {
      success: true,
      posts: rows.slice(0, REYI_PAGE_SIZE),
      hasMore: rows.length > REYI_PAGE_SIZE,
      page,
    };
    setCachedFeed(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('[reyi] feed error:', error.message);
    res.status(500).json({ success: false, message: 'Could not load Reyi posts.' });
  }
});

router.get('/api/reyi/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).end();
    const admin = hasAdminAccess(req);
    const status = getReyiStatus();
    if (!admin && !status.open) return res.status(403).end();

    const { rows } = await pool.query(
      `SELECT story_image_data, story_image_type, status FROM reyi_posts WHERE id = $1`,
      [id]
    );
    const post = rows[0];
    const publiclyAvailable = post && post.status === 'approved';
    if (!post || !post.story_image_data || (!admin && !publiclyAvailable)) {
      return res.status(404).end();
    }
    res.set('Content-Type', post.story_image_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(post.story_image_data);
  } catch {
    res.status(500).end();
  }
});

router.get('/api/reyi/stream/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId || '');
    if (!fileId || fileId.length > 512) return res.status(400).end();
    const admin = hasAdminAccess(req);
    const status = getReyiStatus();
    if (!admin && !status.open) return res.status(403).end();

    const { rows } = await pool.query(
      `SELECT status FROM reyi_posts WHERE post_type = 'video' AND telegram_file_id = $1`,
      [fileId]
    );
    if (!rows.length || (!admin && rows[0].status !== 'approved')) return res.status(404).end();

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
      console.error('[reyi] video stream error:', error.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    upstream.data.pipe(res);
  } catch (error) {
    console.error('[reyi] stream error:', error.message);
    if (!res.headersSent) res.status(502).end();
  }
});

router.post('/api/reyi/posts/:id/react', requireReyiOpen, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const { emoji } = req.body;
    if (!Number.isInteger(id) || (emoji != null && !REACTIONS.has(emoji))) {
      return res.status(400).json({ success: false });
    }
    if (!consumeReactionRate(req)) return res.status(429).json({ success: false, message: 'Too many reactions. Slow down.' });
    const reactorHash = getReactorHash(req);
    if (!reactorHash) {
      return res.status(process.env.SESSION_SECRET ? 401 : 500).json({
        success: false,
        message: process.env.SESSION_SECRET ? 'Refresh Reyi before reacting.' : 'SESSION_SECRET is not configured.',
      });
    }

    await client.query('BEGIN');
    const post = await client.query(
      `SELECT id FROM reyi_posts WHERE id = $1 AND status = 'approved' FOR UPDATE`,
      [id]
    );
    if (!post.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false });
    }
    const existing = await client.query(
      `SELECT emoji FROM reyi_reactions WHERE post_id = $1 AND reactor_hash = $2 FOR UPDATE`,
      [id, reactorHash]
    );
    const previous = existing.rows[0] ? existing.rows[0].emoji : null;
    const next = emoji;
    const updates = [];
    if (previous) updates.push(`react_${previous} = GREATEST(0, react_${previous} - 1)`);
    if (next) updates.push(`react_${next} = react_${next} + 1`);
    if (updates.length) {
      await client.query(`UPDATE reyi_posts SET ${updates.join(', ')} WHERE id = $1`, [id]);
    }
    if (next) {
      await client.query(
        `INSERT INTO reyi_reactions (post_id, reactor_hash, emoji, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (post_id, reactor_hash)
         DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()`,
        [id, reactorHash, next]
      );
    } else {
      await client.query(`DELETE FROM reyi_reactions WHERE post_id = $1 AND reactor_hash = $2`, [id, reactorHash]);
    }
    await client.query('COMMIT');
    invalidateFeedCache();
    res.json({ success: true, emoji: next });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[reyi] reaction error:', error.message);
    res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});

router.get('/api/reyi/posts/:id/comments', requireReyiOpen, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const { rows } = await pool.query(
      `SELECT rc.id, rc.text, rc.created_at
       FROM reyi_comments rc
       JOIN reyi_posts rp ON rp.id = rc.post_id
       WHERE rc.post_id = $1 AND rc.status = 'approved' AND rp.status = 'approved'
       ORDER BY rc.created_at ASC`,
      [id]
    );
    res.json({ success: true, comments: rows });
  } catch {
    res.status(500).json({ success: false, message: 'Could not load comments.' });
  }
});

router.post('/api/reyi/posts/:id/comments', requireReyiOpen, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const ip = clientIp(req);
    const last = lastComment.get(ip);
    if (last && Date.now() - last < COMMENT_RATE_MS) {
      const wait = Math.ceil((COMMENT_RATE_MS - (Date.now() - last)) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${wait}s before commenting again.` });
    }
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'Comment cannot be empty.' });
    if (text.length > 280) return res.status(400).json({ success: false, message: 'Comments must be 280 characters or fewer.' });
    const post = await pool.query(`SELECT id FROM reyi_posts WHERE id = $1 AND status = 'approved'`, [id]);
    if (!post.rows.length) return res.status(404).json({ success: false, message: 'Post not found.' });
    await pool.query(`INSERT INTO reyi_comments (post_id, text) VALUES ($1, $2)`, [id, text]);
    lastComment.set(ip, Date.now());
    res.json({ success: true, message: 'Sent.' });
  } catch (error) {
    console.error('[reyi] comment error:', error.message);
    res.status(500).json({ success: false, message: 'Could not send comment.' });
  }
});

router.post('/api/reyi/admin/login', requireAdmin, (req, res) => {
  setAdminSession(req, res);
  res.json({ success: true });
});

router.post('/api/reyi/admin/logout', (req, res) => {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `reyi_admin=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`);
  res.json({ success: true });
});

router.get('/api/reyi/admin/queue', requireAdmin, async (req, res) => {
  try {
    const { rows: posts } = await pool.query(
      `SELECT id, post_type, telegram_file_id, story_text,
              (story_image_data IS NOT NULL) AS has_story_image, category, caption, created_at
       FROM reyi_posts WHERE status = 'pending' ORDER BY created_at ASC`
    );
    const { rows: comments } = await pool.query(
      `SELECT rc.id, rc.text, rc.created_at, rp.post_number, rp.post_type,
              COALESCE(rp.caption, rp.story_text, 'Video post') AS post_summary
       FROM reyi_comments rc
       JOIN reyi_posts rp ON rp.id = rc.post_id
       WHERE rc.status = 'pending' AND rp.status = 'approved'
       ORDER BY rc.created_at ASC`
    );
    res.json({ success: true, posts, comments });
  } catch {
    res.status(500).json({ success: false, message: 'Could not load queue.' });
  }
});

router.post('/api/reyi/admin/approve/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await client.query('BEGIN');
    const post = await client.query(`SELECT status, post_type, telegram_file_id FROM reyi_posts WHERE id = $1 FOR UPDATE`, [id]);
    if (!post.rows.length || post.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Post is not pending.' });
    }
    if (post.rows[0].post_type === 'video' && !post.rows[0].telegram_file_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Legacy link submissions cannot be approved.' });
    }
    const counter = await client.query(
      `UPDATE reyi_counter SET value = value + 1 WHERE name = 'post_number' RETURNING value`
    );
    const postNumber = counter.rows[0].value;
    await client.query(
      `UPDATE reyi_posts
       SET status = 'approved', post_number = $1, approved_at = NOW(), expires_at = NULL
       WHERE id = $2`,
      [postNumber, id]
    );
    await client.query('COMMIT');
    invalidateFeedCache();
    res.json({ success: true, postNumber });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[reyi] approval error:', error.message);
    res.status(500).json({ success: false, message: 'Could not approve post.' });
  } finally {
    client.release();
  }
});

router.post('/api/reyi/admin/reject/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE reyi_posts SET status = 'rejected' WHERE id = $1 AND status = 'pending'`, [id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not reject post.' });
  }
});

router.post('/api/reyi/admin/approve-comment/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const result = await pool.query(
      `UPDATE reyi_comments SET status = 'approved'
       WHERE id = $1 AND status = 'pending'
       RETURNING post_id`,
      [id]
    );
    if (!result.rows.length) return res.status(400).json({ success: false, message: 'Comment is not pending.' });
    invalidateFeedCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not approve comment.' });
  }
});

router.post('/api/reyi/admin/reject-comment/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`DELETE FROM reyi_comments WHERE id = $1 AND status = 'pending'`, [id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not reject comment.' });
  }
});

module.exports = router;
module.exports.initReyiDb = initReyiDb;