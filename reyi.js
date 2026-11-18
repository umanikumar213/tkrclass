const express = require('express');
const pool = require('./db');
const { ensureReactorIdentity, routeLimit, submissionGuard } = require('./security');
const { adminProtection, clientIp, hasAdminSession, setAdminSession } = require('./lib/admin');
const { createUpload, compressImage, removeTemporaryUploads, validateMp4, IMAGE_MAX_BYTES } = require('./lib/media');
const { telegramConfig, sendVideoToTelegram, telegramFilePath, deleteTelegramMessage } = require('./lib/telegram');
const { FeedCache, feedPage } = require('./lib/feed-cache');
const { reactionHandler } = require('./reactions');
const path = require('path');
const axios = require('axios');

const router = express.Router();

const CATEGORIES = new Set(['Heartache', 'Nostalgia', 'Goosebumps', 'Midnight Thoughts', 'Alone', 'Healing']);
const REACTIONS = new Set(['heartache', 'pleading', 'goosebumps', 'hug', 'healing']);
const REYI_PAGE_SIZE = 10;
const REYI_CACHE_TTL = 300_000;
const feedCache = new FeedCache(REYI_CACHE_TTL);
const lastSubmission = new Map();
const lastComment = new Map();
const SUBMISSION_RATE_MS = 10 * 60 * 1000;
const COMMENT_RATE_MS = 60 * 1000;
const upload = createUpload('reyi', 'story_image');

function invalidateFeedCache() {
  feedCache.clear();
}

function getCachedFeed(key) {
  return feedCache.get(key);
}

function setCachedFeed(key, payload) {
  feedCache.set(key, payload);
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

const { requireAdmin, mediaAccess } = adminProtection(hasAdminSession);
const imageLimit = routeLimit(120, 60000);
const streamLimit = routeLimit(60, 60000);
const reportLimit = routeLimit(10, 3600000);
const reactionLimit = routeLimit(30, 60000);

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of lastComment) {
    if (now - timestamp > COMMENT_RATE_MS * 2) lastComment.delete(ip);
  }
  for (const [ip, timestamp] of lastSubmission) {
    if (now - timestamp > SUBMISSION_RATE_MS * 2) lastSubmission.delete(ip);
  }
}, 10 * 60 * 1000).unref();

async function initReyiDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reyi_posts (
      id                 SERIAL PRIMARY KEY,
      post_number        INTEGER UNIQUE,
      post_type          TEXT NOT NULL CHECK (post_type IN ('video', 'story')),
      telegram_file_id   TEXT,
      legacy_video_archived BOOLEAN NOT NULL DEFAULT FALSE,
      reported           BOOLEAN NOT NULL DEFAULT FALSE,
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
      ADD COLUMN IF NOT EXISTS telegram_file_id TEXT,
      ADD COLUMN IF NOT EXISTS legacy_video_archived BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reported BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
  `);
  console.log('[reyi] DB schema ready');
}

router.get('/reyi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi.html')));
router.get('/reyi/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reyi-admin.html')));

router.get('/api/reyi/status', (req, res) => {
  ensureReactorIdentity(req, res);
  res.json({ success: true, ...getReyiStatus() });
});

router.post('/api/reyi/posts', requireReyiOpen, submissionGuard(lastSubmission, SUBMISSION_RATE_MS), (req, res) => {
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'story_image', maxCount: 1 }])(req, res, async err => {
    if (err) {
      await removeTemporaryUploads(req);
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Videos must be 20MB or smaller.' : err.message;
      return res.status(400).json({ success: false, message });
    }
    try {
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
      let telegramMessageId = null;
      let storyText = null;
      let imageData = null;
      let imageType = null;
      const videoFile = req.files?.video?.[0] || null;
      const storyImage = req.files?.story_image?.[0] || null;

      if (postType === 'video') {
        if (storyImage || !videoFile) {
          return res.status(400).json({ success: false, message: 'Choose an MP4 video file.' });
        }
        await validateMp4(videoFile);
        const uploaded = await sendVideoToTelegram(videoFile);
        telegramFileId = uploaded.fileId;
        telegramMessageId = uploaded.messageId;
      } else {
        if (videoFile) return res.status(400).json({ success: false, message: 'Videos can only be attached to video posts.' });
        if (storyImage && storyImage.size > IMAGE_MAX_BYTES) {
          return res.status(400).json({ success: false, message: 'Images must be 5MB or smaller.' });
        }
        storyText = String(req.body.story_text || '').trim();
        if (!storyText) return res.status(400).json({ success: false, message: 'Write your story first.' });
        if (storyText.length > 2000) return res.status(400).json({ success: false, message: 'Stories must be 2000 characters or fewer.' });
        ({ data: imageData, type: imageType } = await compressImage(storyImage));
      }

      await pool.query(
        `INSERT INTO reyi_posts
          (post_type, telegram_file_id, story_text, story_image_data, story_image_type, category, caption, telegram_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [postType, telegramFileId, storyText, imageData, imageType, category, caption || null, telegramMessageId]
      );
      res.json({ success: true, message: 'Sent.' });
    } catch (error) {
      if (error.code === 'INVALID_VIDEO') return res.status(400).json({ success: false, message: 'Use a valid MP4 video.' });
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
    const { page, beyondLimit } = feedPage(req.query.page);
    if (beyondLimit) return res.json({ success: true, posts: [], hasMore: false, page });
    const category = CATEGORIES.has(req.query.category) ? req.query.category : '';
    const cacheKey = `p${page}|c${category || 'all'}`;
    const cached = getCachedFeed(cacheKey);
    if (cached) return res.json(cached);

    const offset = (page - 1) * REYI_PAGE_SIZE;
    const values = [];
    let where = `status = 'approved'`;
    if (category) {
      values.push(category);
      where += ` AND category = $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, post_number, post_type, telegram_file_id, legacy_video_archived, story_text,
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

router.post('/api/reyi/posts/:id/report', reportLimit, requireReyiOpen, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const result = await pool.query(
      `UPDATE reyi_posts SET reported = TRUE
       WHERE id = $1 AND status = 'approved'
       RETURNING id`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Post not found.' });
    res.json({ success: true, message: 'Reported. An admin will review this post.' });
  } catch {
    res.status(500).json({ success: false, message: 'Could not report this post.' });
  }
});

router.get('/api/reyi/image/:id', imageLimit, mediaAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).end();
    const admin = req.isMediaAdmin;
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

router.get('/api/reyi/stream/:fileId', streamLimit, mediaAccess, async (req, res) => {
  try {
    const fileId = String(req.params.fileId || '');
    if (!fileId || fileId.length > 512) return res.status(400).end();
    const admin = req.isMediaAdmin;
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

router.post('/api/reyi/posts/:id/react', requireReyiOpen, reactionLimit, reactionHandler({
  pool, posts: 'reyi_posts', reactions: 'reyi_reactions', emojis: REACTIONS,
}));

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
      `SELECT id, post_type, telegram_file_id, legacy_video_archived, story_text,
              (story_image_data IS NOT NULL) AS has_story_image, category, caption, reported, status, created_at
       FROM reyi_posts WHERE status = 'pending' OR reported = TRUE ORDER BY created_at ASC`
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
  let client;
  try {
    client = await pool.connect();
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
       SET status = 'approved', post_number = $1, approved_at = NOW(), expires_at = NULL
       WHERE id = $2`,
      [postNumber, id]
    );
    await client.query('COMMIT');
    invalidateFeedCache();
    res.json({ success: true, postNumber });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[reyi] approval error:', error.message);
    res.status(500).json({ success: false, message: 'Could not approve post.' });
  } finally {
    client?.release();
  }
});

router.post('/api/reyi/admin/reject/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const result = await pool.query(
      `DELETE FROM reyi_posts
       WHERE id = $1
       RETURNING telegram_message_id, post_type`,
      [id]
    );
    if (result.rows.length) {
      invalidateFeedCache();
      if (result.rows[0].post_type === 'video') await deleteTelegramMessage(result.rows[0].telegram_message_id);
      return res.json({ success: true });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not remove post.' });
  }
});

router.post('/api/reyi/admin/unflag/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    const result = await pool.query(
      `UPDATE reyi_posts SET reported = FALSE
       WHERE id = $1 AND status = 'approved' AND reported = TRUE
       RETURNING id`,
      [id]
    );
    if (!result.rows.length) return res.status(400).json({ success: false, message: 'Report is no longer active.' });
    invalidateFeedCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not keep post.' });
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
    invalidateFeedCache();
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Could not reject comment.' });
  }
});

module.exports = router;
module.exports.initReyiDb = initReyiDb;