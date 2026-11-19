const express = require('express');
const pool = require('../db');
const { adminProtection, hasAdminSession, setAdminSession } = require('./admin');
const { fields, transaction, lockNote, lockStudent, clearSpotlightCaches } = require('./spotlight-store');
const { invalidateStudentMedia } = require('./spotlight-media');
const { definitions } = require('./spotlight-texts');
const { getContent, clearContent, valid, message } = require('./spotlight-settings');
const crypto = require('node:crypto');

function spotlightAdmin({ wrap, validateRoll, validateId }) {
  const router = express.Router();
  const { requireAdmin } = adminProtection(hasAdminSession);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Translate shared-auth responses locally; other boards retain their existing copy and auth behavior.
  router.use((req, res, next) => {
    const json = res.json;
    res.json = function (body) {
      if (body && typeof body.message === 'string') {
        const locked = body.message.match(/^Too many failed attempts\. Try again in (\d+) minute\(s\)\.$/);
        if (locked) body = { ...body, message: message(req, 'admin_locked', { minutes: locked[1] }) };
        else if (body.message === 'Wrong password.') body = { ...body, message: message(req, 'wrong_password') };
        else if (body.message === 'ADMIN_PASSWORD is not configured.') body = { ...body, message: message(req, 'admin_missing') };
      }
      return json.call(this, body);
    };
    next();
  });
  router.use(requireAdmin);
  router.get('/settings', wrap(async (req, res) => {
    const content = await getContent();
    const { rows } = await pool.query('SELECT DISTINCT year FROM spotlight_students ORDER BY year');
    res.json({
      fields: Object.entries(definitions).map(([key, def]) => ({
        ...def, value: content[def.type === 'text' ? 'texts' : 'settings'][key],
      })),
      years: [...new Set(['1st Year', '2nd Year', '3rd Year', '4th Year', ...rows.map(row => row.year),
        ...content.settings.random_profile_years])],
    });
  }));
  router.post('/settings', wrap(async (req, res) => {
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
      Object.keys(req.body).some(key => key !== 'changes') ||
      Object.entries(changes).some(([key, value]) => !Object.hasOwn(definitions, key) ||
        (value !== null && !valid(definitions[key], value)))) {
      return res.status(400).json({ message: message(req, 'settings_invalid') });
    }
    await transaction(async client => {
      // Concurrent complete saves cannot interleave partial batches.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('spotlight-settings',0))");
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) await client.query('DELETE FROM spotlight_settings WHERE key=$1', [key]);
        else await client.query(
          `INSERT INTO spotlight_settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
          [key, definitions[key].type === 'text' ? value : JSON.stringify(value)]);
      }
    });
    clearContent();
    clearSpotlightCaches();
    res.json({ success: true });
  }));
  router.post('/logout', (req, res) => {
    res.set('Set-Cookie', `reyi_admin=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`);
    res.json({ success: true });
  });
  router.post('/login', (req, res) => {
    if (!process.env.SESSION_SECRET) return res.status(503).json({ message: message(req, 'admin_unconfigured') });
    setAdminSession(req, res);
    res.json({ success: true });
  });
  router.get('/queue', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT n.id,n.roll_number,n.text,n.created_at,n.approved_at,n.status,n.reported,n.report_count,
              reports.last_reported_at,
              s.name,s.course,s.section,s.year
       FROM spotlight_notes n JOIN spotlight_students s USING(roll_number)
       LEFT JOIN LATERAL (
         SELECT MAX(created_at) AS last_reported_at FROM spotlight_note_reports WHERE note_id=n.id
       ) reports ON TRUE
       WHERE n.status='pending' OR (n.status='approved' AND n.reported=TRUE)
       ORDER BY CASE WHEN n.reported THEN COALESCE(reports.last_reported_at,n.created_at) END DESC NULLS LAST,
                n.created_at,n.id`);
    res.json({ pending: rows.filter(n => n.status === 'pending'), reported: rows.filter(n => n.status === 'approved' && n.reported) });
  }));
  router.get('/students', wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const { rows } = await pool.query(
      `SELECT ${fields}, hidden, avatar_group FROM spotlight_students
       WHERE ($1='' OR name ILIKE $2 OR roll_number ILIKE $2)
       ORDER BY hidden DESC, name, roll_number LIMIT 50`, [q, `%${q}%`]);
    const { texts } = await getContent();
    res.json({ students: rows, texts: Object.fromEntries(
      Object.entries(texts).filter(([key]) => definitions[key]?.adminOnly),
    ) });
  }));
  router.post('/students/:roll/avatar', validateRoll, wrap(async (req, res) => {
    const group = req.body?.avatar_group;
    if (!['male', 'female', 'neutral'].includes(group) || Object.keys(req.body).some(key => key !== 'avatar_group')) {
      return res.status(400).json({ message: message(req, 'avatar_invalid') });
    }
    const hidden = await transaction(async client => {
      const student = await lockStudent(client, req.roll, true);
      await client.query('UPDATE spotlight_students SET avatar_group=$2 WHERE roll_number=$1', [req.roll, group]);
      return student.hidden;
    });
    invalidateStudentMedia(req.roll, hidden);
    // The preview bypasses the previous immutable browser entry without putting
    // the private group in the URL. Public immutable copies can last one week.
    res.json({ success: true, avatar_url: `/api/spotlight/avatar/${req.roll}.svg?v=${crypto.randomBytes(8).toString('hex')}` });
  }));
  router.post('/notes/:id/:action', validateId, wrap(async (req, res) => {
    const action = req.params.action;
    if (!['approve', 'keep', 'reject', 'delete'].includes(action)) return res.status(404).json({ message: message(req, 'action_missing') });
    await transaction(async client => {
      const note = await lockNote(client, req.noteId);
      if (action === 'reject' || action === 'delete') {
        await client.query('DELETE FROM spotlight_notes WHERE id=$1', [note.id]);
        if (note.status === 'approved') {
          await client.query('UPDATE spotlight_students SET note_count=GREATEST(0,note_count-1) WHERE roll_number=$1', [note.roll_number]);
        }
      } else {
        await client.query(
          `UPDATE spotlight_notes SET status='approved',reported=FALSE,
           approved_at=CASE WHEN status='approved' THEN approved_at ELSE NOW() END WHERE id=$1`, [note.id]);
        if (note.status !== 'approved') {
          await client.query('UPDATE spotlight_students SET note_count=note_count+1 WHERE roll_number=$1', [note.roll_number]);
        }
      }
    });
    clearSpotlightCaches();
    res.json({ success: true });
  }));
  router.post('/students/:roll/:action', validateRoll, wrap(async (req, res) => {
    if (!['hide', 'unhide'].includes(req.params.action)) return res.status(404).json({ message: message(req, 'action_missing') });
    const hidden = req.params.action === 'hide';
    await transaction(async client => {
      await lockStudent(client, req.roll, true);
      await client.query('UPDATE spotlight_students SET hidden=$2,updated_at=NOW() WHERE roll_number=$1', [req.roll, hidden]);
    });
    invalidateStudentMedia(req.roll, hidden);
    clearSpotlightCaches();
    res.json({ success: true, hidden });
  }));
  return router;
}
module.exports = { spotlightAdmin };
