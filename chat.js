const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only jpg, png and webp images are allowed'), ok);
  }
});

// --- rate limit: 1 post per 3 minutes per IP ---
const lastPost = new Map();
const RATE_MS = 3 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RATE_MS;
  for (const [ip, t] of lastPost) if (t < cutoff) lastPost.delete(ip);
}, 10 * 60 * 1000).unref();

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// --- admin auth ---
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ success: false, message: 'ADMIN_PASSWORD is not configured.' });
  if (pass !== process.env.ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Wrong password.' });
  next();
}

// delete posts older than 7 days (rolling, per post)
async function purgeExpired() {
  await pool.query(`DELETE FROM confessions WHERE created_at < NOW() - INTERVAL '7 days'`);
}

// --- pages ---
router.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
router.get('/chat/admin', (req, res) => res.sendFile(path.join(__dirname, 'chat-admin.html')));

// --- public API ---
router.post('/api/chat/posts', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : err.message;
      return res.status(400).json({ success: false, message: msg });
    }
    try {
      const ip = clientIp(req);
      const last = lastPost.get(ip);
      if (last && Date.now() - last < RATE_MS) {
        const wait = Math.ceil((RATE_MS - (Date.now() - last)) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${Math.ceil(wait / 60)} minute(s) before posting again.` });
      }
      const text = (req.body.text || '').trim();
      if (!text) return res.status(400).json({ success: false, message: 'Confession text is required.' });
      if (text.length > 500) return res.status(400).json({ success: false, message: 'Max 500 characters.' });

      let imageData = null, imageType = null;
      if (req.file) {
        // Re-encode with sharp: strips ALL metadata (EXIF/GPS) for privacy
        if (req.file.mimetype === 'image/png') {
          imageData = await sharp(req.file.buffer).rotate().png().toBuffer();
          imageType = 'image/png';
        } else if (req.file.mimetype === 'image/webp') {
          imageData = await sharp(req.file.buffer).rotate().webp({ quality: 85 }).toBuffer();
          imageType = 'image/webp';
        } else {
          imageData = await sharp(req.file.buffer).rotate().jpeg({ quality: 85 }).toBuffer();
          imageType = 'image/jpeg';
        }
      }

      await pool.query(
        `INSERT INTO confessions (text, image_data, image_type, status) VALUES ($1, $2, $3, 'pending')`,
        [text, imageData, imageType]
      );
      lastPost.set(ip, Date.now());
      res.json({ success: true, message: 'Your post has been submitted for approval. It will appear once an admin approves it.' });
    } catch (e) {
      console.error('post submit error:', e.message);
      res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
  });
});

router.get('/api/chat/posts', async (req, res) => {
  try {
    await purgeExpired();
    const params = [];
    let where = `status = 'approved'`;
    if (req.query.day && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)) {
      params.push(req.query.day);
      where += ` AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, post_number, text, (image_data IS NOT NULL) AS has_image, created_at
       FROM confessions WHERE ${where} ORDER BY post_number DESC`, params);
    res.json({ success: true, posts: rows });
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
    // pending images only visible to admin
    if (rows[0].status !== 'approved' && req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
      return res.status(404).end();
    }
    res.set('Content-Type', rows[0].image_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(rows[0].image_data);
  } catch { res.status(500).end(); }
});

router.post('/api/chat/posts/:id/report', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false });
    await pool.query(`UPDATE confessions SET reported = TRUE WHERE id = $1 AND status = 'approved'`, [id]);
    res.json({ success: true, message: 'Reported. An admin will review this post.' });
  } catch { res.status(500).json({ success: false }); }
});

// --- admin API ---
router.post('/api/chat/admin/login', requireAdmin, (req, res) => res.json({ success: true }));

router.get('/api/chat/admin/queue', requireAdmin, async (req, res) => {
  try {
    await purgeExpired();
    const { rows } = await pool.query(
      `SELECT id, post_number, text, (image_data IS NOT NULL) AS has_image, status, reported, created_at
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

module.exports = router;
