const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const { initSpotlightSchema } = require('./lib/spotlight-db');
const { hiddenRolls, initSpotlightMedia, getPhoto, getOg, sendImage } = require('./lib/spotlight-media');
const { identity, spotlightLimit, verifyTurnstile, turnstileEnabled } = require('./lib/spotlight-security');
const {
  fields, lists, boards, filters, clearProfile, clearSpotlightCaches,
  fail, transaction, lockStudent, lockNote, publicProfile,
} = require('./lib/spotlight-store');
const { spotlightAdmin } = require('./lib/spotlight-admin');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(error => {
  if (error.status) return res.status(error.status).json({ message: error.message });
  next(error);
});
function validateRoll(req, res, next) {
  req.roll = String(req.params.roll || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(req.roll)) return res.status(400).json({ message: 'Invalid roll number.' });
  next();
}
function validateId(req, res, next) {
  req.noteId = Number(req.params.id);
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(req.noteId) || req.noteId > 2147483647) {
    return res.status(400).json({ message: 'Invalid note ID.' });
  }
  next();
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function publicOrigin(req) {
  try {
    const value = new URL(process.env.PUBLIC_URL);
    if (['https:', 'http:'].includes(value.protocol) && !value.username && !value.password) return value.origin;
  } catch { /* Explicit deployment URL is optional. */ }
  return `${req.protocol}://${req.get('host')}`;
}
router.get('/spotlight', (req, res) => res.sendFile(path.join(__dirname, 'public/spotlight.html')));
router.get('/spotlight/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/spotlight-admin.html')));
router.get('/spotlight/:roll', validateRoll, wrap(async (req, res) => {
  if (req.params.roll !== req.roll) return res.redirect(301, `/spotlight/${req.roll}`);
  const profile = hiddenRolls.has(req.roll) ? null : await publicProfile(req.roll);
  const origin = publicOrigin(req);
  const tags = {
    'og:title': profile ? `${profile.student.name} on TKR Spotlight` : 'TKR Spotlight',
    'og:description': profile ? `${profile.student.course} · ${profile.student.year}` : 'Discover the people of TKR.',
    'og:type': profile ? 'profile' : 'website',
    'og:url': `${origin}/spotlight${profile ? `/${req.roll}` : ''}`,
    'og:image': `${origin}/api/spotlight/og/${profile ? req.roll : 'SPOTLIGHT'}.jpg`,
    'og:image:width': '400', 'og:image:height': '400',
  };
  const meta = Object.entries(tags).map(([key, value]) => `<meta property="${key}" content="${escapeHtml(value)}">`).join('\n');
  const template = fs.readFileSync(path.join(__dirname, 'public/spotlight-profile.html'), 'utf8');
  res.set('Cache-Control', 'no-store').status(profile ? 200 : 404).type('html').send(template.replace('<!--SPOTLIGHT_META-->', meta));
}));

router.get('/api/spotlight/config', (req, res) => res.json({ turnstileSiteKey: turnstileEnabled() ? process.env.TURNSTILE_SITE_KEY : null }));
router.use('/api/spotlight/admin', spotlightAdmin({ wrap, validateRoll, validateId }));

router.get('/api/spotlight/filters', wrap(async (req, res) => {
  let payload = filters.get('all');
  if (payload === undefined) {
    const revision = filters.revision;
    const { rows } = await pool.query('SELECT DISTINCT year,course,section FROM spotlight_students WHERE hidden=FALSE ORDER BY year,course,section');
    const years = [...new Set(rows.map(row => row.year))];
    const courseMap = new Map();
    for (const row of rows) courseMap.set(JSON.stringify([row.year, row.course]), { year: row.year, course: row.course });
    payload = { years, courses: [...courseMap.values()], sections: rows.filter(row => row.section !== null) };
    if (filters.revision === revision) filters.set('all', payload);
  }
  res.json(payload);
}));
router.get('/api/spotlight/students', wrap(async (req, res) => {
  const pageNumber = Number(req.query.page || 1);
  const page = Number.isFinite(pageNumber) ? Math.max(1, Math.floor(pageNumber)) : 201;
  if (page > 200) return res.json({ students: [], hasMore: false, page });
  const read = name => typeof req.query[name] === 'string' ? req.query[name].trim().slice(0, 100) : '';
  const year = read('year'), course = read('course').toUpperCase(), section = read('section'), q = read('q');
  const key = JSON.stringify([year, course, section, q, page]);
  let payload = lists.get(key);
  if (payload === undefined) {
    const revision = lists.revision;
    const { rows } = await pool.query(
      `SELECT ${fields} FROM spotlight_students WHERE hidden=FALSE
       AND ($1='' OR year=$1) AND ($2='' OR course=$2) AND ($3='' OR section=$3)
       AND ($4='' OR name ILIKE $5 OR roll_number ILIKE $5)
       ORDER BY name,roll_number LIMIT 31 OFFSET $6`, [year, course, section, q, `%${q}%`, (page - 1) * 30]);
    payload = { students: rows.slice(0, 30), hasMore: rows.length > 30, page };
    if (lists.revision === revision) lists.set(key, payload);
  }
  res.json({ ...payload, students: payload.students.filter(student => !hiddenRolls.has(student.roll_number)) });
}));
router.get('/api/spotlight/random', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT roll_number FROM spotlight_students WHERE hidden=FALSE ORDER BY RANDOM() LIMIT 1');
  if (!rows.length) return res.status(404).json({ message: 'No profiles available yet.' });
  res.json(rows[0]);
}));
router.get('/api/spotlight/leaderboard', wrap(async (req, res) => {
  const tab = req.query.tab || 'trending';
  if (!['trending', 'liked', 'noted'].includes(tab)) return res.status(400).json({ message: 'Invalid leaderboard tab.' });
  let payload = boards.get(tab);
  if (payload === undefined) {
    const revision = boards.revision;
    let query;
    if (tab === 'trending') {
      query = `WITH recent_likes AS (
        SELECT roll_number,COUNT(*)::INT AS total FROM spotlight_likes
        WHERE created_at >= NOW()-INTERVAL '24 hours' GROUP BY roll_number
      ), recent_notes AS (
        SELECT roll_number,COUNT(*)::INT AS total FROM spotlight_notes
        WHERE status='approved' AND reported=FALSE AND approved_at >= NOW()-INTERVAL '24 hours' GROUP BY roll_number
      ) SELECT s.roll_number,s.name,s.course,s.section,s.year,s.like_count,s.note_count,
        (COALESCE(l.total,0)+2*COALESCE(n.total,0))::INT AS score
        FROM spotlight_students s LEFT JOIN recent_likes l USING(roll_number) LEFT JOIN recent_notes n USING(roll_number)
        WHERE s.hidden=FALSE ORDER BY score DESC,s.name,s.roll_number LIMIT 20`;
    } else {
      // Identifiers are selected only from this fixed allow-list, never request input.
      const column = tab === 'liked' ? 'like_count' : 'note_count';
      query = `SELECT ${fields},${column} AS score FROM spotlight_students
        WHERE hidden=FALSE ORDER BY ${column} DESC,name,roll_number LIMIT 20`;
    }
    const { rows } = await pool.query(query);
    payload = { students: rows };
    if (boards.revision === revision) boards.set(tab, payload);
  }
  res.json({ students: payload.students.filter(student => !hiddenRolls.has(student.roll_number)) });
}));

const imageLimit = spotlightLimit(300, 60000);
router.get('/api/spotlight/photo/:roll', imageLimit, validateRoll, wrap(async (req, res) => {
  const photo = await getPhoto(req.roll);
  if (!photo || hiddenRolls.has(req.roll)) return res.status(404).set('Cache-Control', 'no-store').end();
  sendImage(req, res, photo, 'image/webp');
}));
router.get('/api/spotlight/og/:roll.jpg', imageLimit, validateRoll, wrap(async (req, res) => {
  const image = await getOg(req.roll);
  sendImage(req, res, image, 'image/jpeg');
}));
router.get('/api/spotlight/students/:roll', validateRoll, identity, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const profile = hiddenRolls.has(req.roll) ? null : await publicProfile(req.roll);
  if (!profile) return res.status(404).json({ message: 'Student not found.' });
  const [likes, reactions] = await Promise.all([
    pool.query('SELECT 1 FROM spotlight_likes WHERE roll_number=$1 AND voter_hash=$2', [req.roll, req.voterHash]),
    pool.query(
      `SELECT r.note_id,r.emoji FROM spotlight_note_reactions r JOIN spotlight_notes n ON n.id=r.note_id
       WHERE n.roll_number=$1 AND n.status='approved' AND n.reported=FALSE AND r.voter_hash=$2`, [req.roll, req.voterHash]),
  ]);
  const mine = new Map(reactions.rows.map(row => [row.note_id, row.emoji]));
  if (hiddenRolls.has(req.roll)) return res.status(404).json({ message: 'Student not found.' });
  res.json({ student: profile.student, likedByMe: Boolean(likes.rows.length),
    notes: profile.notes.map(note => ({ ...note, myReaction: mine.get(note.id) || null })) });
}));

router.post('/api/spotlight/students/:roll/like', validateRoll, identity, spotlightLimit(60, 3600000), verifyTurnstile, wrap(async (req, res) => {
  const payload = await transaction(async client => {
    await lockStudent(client, req.roll);
    const old = await client.query('SELECT 1 FROM spotlight_likes WHERE roll_number=$1 AND voter_hash=$2', [req.roll, req.voterHash]);
    const liked = old.rows.length === 0;
    if (liked) {
      const count = await client.query(
        `SELECT COUNT(*)::INT AS total FROM spotlight_likes
         WHERE roll_number=$1 AND ip_hash=$2 AND created_at >= NOW()-INTERVAL '24 hours'`, [req.roll, req.spotlightIp]);
      if (count.rows[0].total >= 3) fail(429, 'This network has reached the daily like limit for this profile.');
      await client.query('INSERT INTO spotlight_likes(roll_number,voter_hash,ip_hash) VALUES($1,$2,$3)', [req.roll, req.voterHash, req.spotlightIp]);
    } else {
      await client.query('DELETE FROM spotlight_likes WHERE roll_number=$1 AND voter_hash=$2', [req.roll, req.voterHash]);
    }
    const { rows } = await client.query(
      'UPDATE spotlight_students SET like_count=GREATEST(0,like_count+$2) WHERE roll_number=$1 RETURNING like_count', [req.roll, liked ? 1 : -1]);
    return { liked, like_count: rows[0].like_count };
  });
  // Leaderboards intentionally keep their ten-minute cache; profile counts must be fresh.
  clearProfile(req.roll);
  res.json(payload);
}));
router.post('/api/spotlight/students/:roll/notes', validateRoll, identity, spotlightLimit(1, 120000), verifyTurnstile, wrap(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 200) return res.status(400).json({ message: 'Write a note of 1–200 characters.' });
  await transaction(async client => {
    // Serializes this IP across different profiles as well as across app replicas.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`spotlight-note:${req.spotlightIp}`]);
    await lockStudent(client, req.roll);
    const pending = await client.query(
      `SELECT COUNT(*)::INT AS total FROM spotlight_notes WHERE ip_hash=$1 AND status='pending'`, [req.spotlightIp]);
    if (pending.rows[0].total >= 10) fail(429, 'You already have 10 notes waiting for review.');
    await client.query('INSERT INTO spotlight_notes(roll_number,text,ip_hash) VALUES($1,$2,$3)', [req.roll, text, req.spotlightIp]);
  });
  res.json({ success: true, message: 'Your note will appear after review.' });
}));
router.post('/api/spotlight/notes/:id/react', validateId, identity, spotlightLimit(30, 60000), wrap(async (req, res) => {
  const emoji = req.body?.emoji;
  const columns = { heart: 'react_heart', laugh: 'react_laugh', fire: 'react_fire' };
  if (!Object.hasOwn(columns, emoji)) return res.status(400).json({ message: 'Invalid reaction.' });
  const result = await transaction(async client => {
    const note = await lockNote(client, req.noteId, true);
    const old = await client.query('SELECT emoji FROM spotlight_note_reactions WHERE note_id=$1 AND voter_hash=$2', [note.id, req.voterHash]);
    const previous = old.rows[0]?.emoji;
    const next = previous === emoji ? null : emoji;
    if (next) {
      await client.query(
        `INSERT INTO spotlight_note_reactions(note_id,voter_hash,emoji) VALUES($1,$2,$3)
         ON CONFLICT(note_id,voter_hash) DO UPDATE SET emoji=EXCLUDED.emoji`, [note.id, req.voterHash, next]);
    } else {
      await client.query('DELETE FROM spotlight_note_reactions WHERE note_id=$1 AND voter_hash=$2', [note.id, req.voterHash]);
    }
    if (previous && Object.hasOwn(columns, previous)) {
      await client.query(`UPDATE spotlight_notes SET ${columns[previous]}=GREATEST(0,${columns[previous]}-1) WHERE id=$1`, [note.id]);
    }
    if (next) await client.query(`UPDATE spotlight_notes SET ${columns[next]}=${columns[next]}+1 WHERE id=$1`, [note.id]);
    const { rows } = await client.query('SELECT react_heart,react_laugh,react_fire FROM spotlight_notes WHERE id=$1', [note.id]);
    const row = rows[0];
    return { roll: note.roll_number, myReaction: next, counts: { heart: row.react_heart, laugh: row.react_laugh, fire: row.react_fire } };
  });
  clearProfile(result.roll);
  res.json({ counts: result.counts, myReaction: result.myReaction });
}));
router.post('/api/spotlight/notes/:id/report', validateId, identity, spotlightLimit(10, 3600000), wrap(async (req, res) => {
  await transaction(async client => {
    const note = await lockNote(client, req.noteId, true);
    await client.query('UPDATE spotlight_notes SET reported=TRUE WHERE id=$1', [note.id]);
  });
  // A reported note must vanish immediately, including from warmed shared profiles.
  clearSpotlightCaches();
  res.json({ success: true });
}));

async function initSpotlightDb() {
  await initSpotlightSchema();
  await initSpotlightMedia();
}
module.exports = router;
module.exports.initSpotlightDb = initSpotlightDb;
