const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const CATEGORIES = new Set(['Heartbreak', 'Inspiration', 'Goosebumps', 'Deep Thoughts', 'Late Night Vibe']);
const REACTIONS = new Set(['heartbreak', 'sad', 'love', 'fire', 'sparkles']);
const REYI_PAGE_SIZE = 10;
const REYI_CACHE_TTL = 300_000;
const feedCache = new Map();
const lastSubmission = new Map();
const reactionWindows = new Map();
const adminFailures = new Map();
const SUBMISSION_RATE_MS = 10 * 60 * 1000;
const REACTION_WINDOW_MS = 60 * 1000;
const REACTION_MAX_PER_WINDOW = 30;
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(allowed ? null : new Error('Only jpg, png and webp images are allowed'), allowed);
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
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
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

function hasAdminAccess(req) {
  return Boolean(process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD);
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

function parseVideoUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
      return { source: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
    }
  }

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    let id = url.searchParams.get('v');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!id && (parts[0] === 'shorts' || parts[0] === 'embed')) id = parts[1];
    if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
      return { source: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
    }
  }

  if (host === 'instagram.com' || host === 'm.instagram.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const type = parts[0];
    const code = parts[1];
    if (['reel', 'p', 'tv'].includes(type) && code && /^[A-Za-z0-9_-]{5,}$/.test(code)) {
      return { source: 'instagram', embedUrl: `https://www.instagram.com/${type}/${code}/embed/` };
    }
  }
  return null;
}

async function compressStoryImage(file) {
  if (!file) return { data: null, type: null };
  const resize = { width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true };
  if (file.mimetype === 'image/png') {
    return { data: await sharp(file.buffer).rotate().resize(resize).png({ quality: 75, compressionLevel: 8 }).toBuffer(), type: 'image/png' };
  }
  if (file.mimetype === 'image/webp') {
    return { data: await sharp(file.buffer).rotate().resize(resize).webp({ quality: 75 }).toBuffer(), type: 'image/webp' };
  }
  return { data: await sharp(file.buffer).rotate().resize(resize).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), type: 'image/jpeg' };
}

async function purgeExpiredPosts() {
  const result = await pool.query(
    `DELETE FROM reyi_posts WHERE status = 'approved' AND expires_at <= NOW()`
  );
  if (result.rowCount > 0) invalidateFeedCache();
}

setInterval(() => {
  purgeExpiredPosts().catch(error => console.error('[reyi] expiry cleanup error:', error.message));
  const now = Date.now();
  for (const [ip, state] of reactionWindows) {
    if (now - state.startedAt > REACTION_WINDOW_MS * 2) reactionWindows.delete(ip);
  }
  for (const [ip, state] of adminFailures) {
    if ((state.lockedUntil && state.lockedUntil <= now) || now - state.windowStart > ADMIN_WINDOW_MS + ADMIN_LOCKOUT_MS) {
      adminFailures.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

async function initReyiDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reyi_posts (
      id                 SERIAL PRIMARY KEY,
      post_number        INTEGER UNIQUE,
      post_type          TEXT NOT NULL CHECK (post_type IN ('video', 'story')),
      video_source_type  TEXT,
      video_url          TEXT,
      story_text         VARCHAR(2000),
      story_image_data   BYTEA,
      story_image_type   TEXT,
      category           VARCHAR(60) NOT NULL,
      caption            VARCHAR(150),
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      approved_at        TIMESTAMPTZ,
      expires_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      react_heartbreak   INTEGER NOT NULL DEFAULT 0,
      react_sad          INTEGER NOT NULL DEFAULT 0,
      react_love         INTEGER NOT NULL DEFAULT 0,
      react_fire         INTEGER NOT NULL DEFAULT 0,
      react_sparkles     INTEGER NOT NULL DEFAULT 0
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
    INSERT INTO reyi_counter (name, value) VALUES ('post_number', 0)
      ON CONFLICT (name) DO NOTHING;
    CREATE INDEX IF NOT EXISTS idx_reyi_posts_feed
      ON reyi_posts (status, category, post_number DESC);
    CREATE INDEX IF NOT EXISTS idx_reyi_posts_expiry
      ON reyi_posts (expires_at);
  `);
  await purgeExpiredPosts();
  console.log('[reyi] DB schema ready');
}

router.get('/reyi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi.html')));
router.get('/reyi/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi-admin.html')));

router.get('/api/reyi/status', (req, res) => {
  ensureReactorIdentity(req, res);
  res.json({ success: true, ...getReyiStatus() });
});

router.post('/api/reyi/posts', requireReyiOpen, (req, res) => {
  upload.single('story_image')(req, res, async err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : err.message;
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

      let videoSourceType = null;
      let videoUrl = null;
      let storyText = null;
      let imageData = null;
      let imageType = null;

      if (postType === 'video') {
        if (req.file) return res.status(400).json({ success: false, message: 'Images can only be attached to stories.' });
        const video = parseVideoUrl(req.body.video_url);
        if (!video) {
          return res.status(400).json({ success: false, message: 'Use a valid YouTube or Instagram Reel link.' });
        }
        videoSourceType = video.source;
        videoUrl = video.embedUrl;
      } else {
        storyText = String(req.body.story_text || '').trim();
        if (!storyText) return res.status(400).json({ success: false, message: 'Write your story first.' });
        if (storyText.length > 2000) return res.status(400).json({ success: false, message: 'Stories must be 2000 characters or fewer.' });
        ({ data: imageData, type: imageType } = await compressStoryImage(req.file));
      }

      await pool.query(
        `INSERT INTO reyi_posts
          (post_type, video_source_type, video_url, story_text, story_image_data, story_image_type, category, caption)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [postType, videoSourceType, videoUrl, storyText, imageData, imageType, category, caption || null]
      );
      lastSubmission.set(ip, Date.now());
      res.json({ success: true, message: 'Submitted for admin approval.' });
    } catch (error) {
      console.error('[reyi] submission error:', error.message);
      res.status(500).json({ success: false, message: 'Could not submit right now.' });
    }
  });
});

router.get('/api/reyi/posts', requireReyiOpen, async (req, res) => {
  try {
    await purgeExpiredPosts();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const category = CATEGORIES.has(req.query.category) ? req.query.category : '';
    const cacheKey = `p${page}|c${category || 'all'}`;
    const cached = getCachedFeed(cacheKey);
    if (cached) return res.json(cached);

    const offset = (page - 1) * REYI_PAGE_SIZE;
    const values = [];
    let where = `status = 'approved' AND expires_at > NOW()`;
    if (category) {
      values.push(category);
      where += ` AND category = $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, post_number, post_type, video_source_type, video_url, story_text,
              (story_image_data IS NOT NULL) AS has_story_image, category, caption, created_at,
              react_heartbreak, react_sad, react_love, react_fire, react_sparkles
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
      `SELECT story_image_data, story_image_type, status, expires_at FROM reyi_posts WHERE id = $1`,
      [id]
    );
    const post = rows[0];
    const publiclyAvailable = post && post.status === 'approved' && post.expires_at && new Date(post.expires_at).getTime() > Date.now();
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
      `SELECT id FROM reyi_posts WHERE id = $1 AND status = 'approved' AND expires_at > NOW() FOR UPDATE`,
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
    res.json({ success: true, emoji: next });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[reyi] reaction error:', error.message);
    res.status(500).json({ success: false });
  } finally {
    client.release();
  }
});

router.post('/api/reyi/admin/login', requireAdmin, (req, res) => res.json({ success: true }));

router.get('/api/reyi/admin/queue', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, post_type, video_source_type, video_url, story_text,
              (story_image_data IS NOT NULL) AS has_story_image, category, caption, created_at
       FROM reyi_posts WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json({ success: true, posts: rows });
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
    const post = await client.query(`SELECT status FROM reyi_posts WHERE id = $1 FOR UPDATE`, [id]);
    if (!post.rows.length || post.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Post is not pending.' });
    }
    const counter = await client.query(
      `UPDATE reyi_counter SET value = value + 1 WHERE name = 'post_number' RETURNING value`
    );
    const postNumber = counter.rows[0].value;
    await client.query(
      `UPDATE reyi_posts
       SET status = 'approved', post_number = $1, approved_at = NOW(), expires_at = NOW() + INTERVAL '7 days'
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

module.exports = router;
module.exports.initReyiDb = initReyiDb;