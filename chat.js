const express = require('express');
const pool = require('./db');
const { ensureReactorIdentity, routeLimit, submissionGuard } = require('./security');
const { adminProtection, clientIp } = require('./lib/admin');
const { createUpload, compressImage, removeTemporaryUploads, validateMp4, IMAGE_MAX_BYTES } = require('./lib/media');
const { telegramConfig, sendVideoToTelegram, telegramFilePath, deleteTelegramMessage } = require('./lib/telegram');
const { FeedCache, feedPage } = require('./lib/feed-cache');
const { runMigration } = require('./lib/migrations');
const { reactionHandler } = require('./reactions');
const path = require('path');
const axios = require('axios');

const CHAT_MOODS = new Set([
  'Heartache',
  'Nostalgia',
  'Goosebumps',
  'Midnight Thoughts',
  'Alone',
  'Other / Casual',
]);
// --- feed cache (5-minute TTL, invalidated immediately on admin actions) ---
const FEED_CACHE_TTL = 300_000; // 300 seconds in ms
const feedCache = new FeedCache(FEED_CACHE_TTL);
function invalidateFeedCache() { feedCache.clear(); }
function getFeedCache(key) {
  return feedCache.get(key);
}
function setFeedCache(key, data) {
  feedCache.set(key, data);
}

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
      ADD COLUMN IF NOT EXISTS video_file_id TEXT,
      ADD COLUMN IF NOT EXISTS mood TEXT NOT NULL DEFAULT 'Other / Casual';
    ALTER TABLE confessions
      ADD COLUMN IF NOT EXISTS is_admin_post BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE confessions ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
    CREATE TABLE IF NOT EXISTS chat_reactions (
      post_id INTEGER NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
      reactor_hash VARCHAR(64) NOT NULL,
      emoji VARCHAR(20) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(post_id, reactor_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_confessions_mood_approved
      ON confessions (mood, post_number DESC) WHERE status = 'approved';
  `);
  await runMigration('chat_text_limit_2500', 'ALTER TABLE confessions ALTER COLUMN text TYPE VARCHAR(2500)');
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

const upload = createUpload('chat', 'image');

// --- rate limit: 1 post per 3 minutes per IP ---
const lastPost = new Map();
const RATE_MS = 3 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_MS;
  for (const [ip, t] of lastPost) if (t < cutoff) lastPost.delete(ip);
}, 10 * 60 * 1000).unref();

const { requireAdmin, mediaAccess } = adminProtection();
const imageLimit = routeLimit(120, 60000);
const streamLimit = routeLimit(60, 60000);
const reportLimit = routeLimit(10, 3600000);
const reactionLimit = routeLimit(30, 60000);

// --- pages ---
router.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
router.get('/chat/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat-admin.html')));

// --- public API ---
function submitPost(req, res, adminPost = false) {
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
      const text = String(req.body.text || '').trim();
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
      const uploadedVideo = video ? await sendVideoToTelegram(video) : null;
      const videoFileId = uploadedVideo?.fileId ?? null;
      const telegramMessageId = uploadedVideo?.messageId ?? null;

      if (adminPost) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const counter = await client.query(
            `UPDATE confession_counter SET value = value + 1 WHERE name = 'post_number' RETURNING value`);
          const result = await client.query(
            `INSERT INTO confessions
             (text, image_data, image_type, video_file_id, mood, status, post_number, is_admin_post, is_pinned, telegram_message_id)
             VALUES ($1, $2, $3, $4, $5, 'approved', $6, TRUE, TRUE, $7) RETURNING id`,
            [text, imageData, imageType, videoFileId, mood, counter.rows[0].value, telegramMessageId]);
          await client.query('COMMIT');
          invalidateFeedCache();
          res.json({ success: true, id: result.rows[0].id, message: 'Published and pinned to the confession board until you remove it.' });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } else {
        await pool.query(
          `INSERT INTO confessions (text, image_data, image_type, video_file_id, mood, status, telegram_message_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [text, imageData, imageType, videoFileId, mood, telegramMessageId]
        );
        res.json({ success: true, message: 'Your post has been submitted for approval. It will appear once an admin approves it.' });
      }
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
}

// Only this authenticated route can publish and pin; multipart fields cannot grant admin status.
router.post('/api/chat/posts', submissionGuard(lastPost, RATE_MS), (req, res) => submitPost(req, res));
router.post('/api/chat/admin/posts', requireAdmin, (req, res) => submitPost(req, res, true));

router.get('/api/chat/posts', async (req, res) => {
  ensureReactorIdentity(req, res);
  try {
    const PAGE_SIZE = 10;
    const { page, beyondLimit } = feedPage(req.query.page);
    if (beyondLimit) return res.json({ success: true, posts: [], hasMore: false, page });
    const mood = CHAT_MOODS.has(req.query.mood) ? req.query.mood : '';

    const cacheKey = `p${page}|m${mood || 'all'}`;
    const cached = getFeedCache(cacheKey);
    if (cached) return res.json(cached);

    const offset = (page - 1) * PAGE_SIZE;
    const params = [];
    let where = `status = 'approved'`;
    if (mood) { params.push(mood); where += ` AND (mood = $1 OR is_pinned = TRUE)`; }

    const { rows } = await pool.query(
      `SELECT id, post_number, text, mood, is_admin_post, is_pinned, (image_data IS NOT NULL) AS has_image,
              (video_file_id IS NOT NULL) AS has_video, video_file_id, created_at,
              react_heart, react_laugh, react_wow, react_sad, react_fire, react_up,
              (SELECT COUNT(*) FROM confession_comments cc
               WHERE cc.confession_id = confessions.id AND cc.status = 'approved') AS comment_count
       FROM confessions WHERE ${where} ORDER BY is_pinned DESC, post_number DESC, id DESC
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

router.get('/api/chat/image/:id', imageLimit, mediaAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).end();
    const { rows } = await pool.query(`SELECT image_data, image_type, status FROM confessions WHERE id = $1`, [id]);
    if (!rows.length || !rows[0].image_data) return res.status(404).end();
    // pending images only visible to admin; fail closed if ADMIN_PASSWORD is unset
    if (rows[0].status !== 'approved' && !req.isMediaAdmin) {
      return res.status(404).end();
    }
    res.set('Content-Type', rows[0].image_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(rows[0].image_data);
  } catch { res.status(500).end(); }
});

router.get('/api/chat/stream/:fileId', streamLimit, mediaAccess, async (req, res) => {
  try {
    const fileId = String(req.params.fileId || '');
    if (!fileId || fileId.length > 512) return res.status(400).end();
    const { rows } = await pool.query(
      `SELECT status FROM confessions WHERE video_file_id = $1`,
      [fileId]
    );
    const isAdmin = req.isMediaAdmin;
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
router.post('/api/chat/posts/:id/react', reactionLimit, reactionHandler({
  pool, posts: 'confessions', reactions: 'chat_reactions', emojis: VALID_EMOJIS,
}));

router.post('/api/chat/posts/:id/report', reportLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const result = await pool.query(`UPDATE confessions SET reported = TRUE WHERE id = $1 AND status = 'approved' RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Post not found.' });
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
      `SELECT cc.id, cc.text, cc.created_at FROM confession_comments cc
       JOIN confessions c ON c.id = cc.confession_id AND c.status = 'approved'
       WHERE cc.confession_id = $1 AND cc.status = 'approved' ORDER BY cc.created_at ASC`, [id]);
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
      `SELECT id, post_number, text, mood, is_admin_post, is_pinned, (image_data IS NOT NULL) AS has_image,
              (video_file_id IS NOT NULL) AS has_video, video_file_id, status, reported, created_at
       FROM confessions WHERE status = 'pending' OR reported = TRUE OR is_pinned = TRUE
       ORDER BY is_pinned DESC, created_at ASC`);
    res.json({ success: true, posts: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load queue.' });
  }
});

router.post('/api/chat/admin/approve/:id', requireAdmin, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
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
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('approve error:', e.message);
    res.status(500).json({ success: false, message: 'Approve failed.' });
  } finally { client?.release(); }
});

// reject (pending) or delete (reported/approved): permanently removes everything
router.post('/api/chat/admin/reject/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const deleted = await pool.query(
      `DELETE FROM confessions WHERE id = $1 RETURNING telegram_message_id, video_file_id`, [id]);
    invalidateFeedCache();
    if (deleted.rows[0]?.video_file_id) await deleteTelegramMessage(deleted.rows[0].telegram_message_id);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Delete failed.' }); }
});

router.post('/api/chat/admin/unflag/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE confessions SET reported = FALSE WHERE id = $1`, [id]);
    invalidateFeedCache();
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
    invalidateFeedCache();
    res.json({ success: true });
  } catch { res.status(500).json({ success: false, message: 'Reject failed.' }); }
});

router.initDb = initDb;
module.exports = router;
