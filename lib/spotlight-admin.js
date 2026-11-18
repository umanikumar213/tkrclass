const express = require('express');
const pool = require('../db');
const { adminProtection, hasAdminSession, setAdminSession } = require('./admin');
const { fields, transaction, lockNote, lockStudent, clearSpotlightCaches } = require('./spotlight-store');
const { invalidateStudentMedia } = require('./spotlight-media');

function spotlightAdmin({ wrap, validateRoll, validateId }) {
  const router = express.Router();
  const { requireAdmin } = adminProtection(hasAdminSession);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(requireAdmin);
  router.post('/logout', (req, res) => {
    res.set('Set-Cookie', `reyi_admin=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`);
    res.json({ success: true });
  });
  router.post('/login', (req, res) => {
    if (!process.env.SESSION_SECRET) return res.status(503).json({ message: 'Admin sessions are not configured.' });
    setAdminSession(req, res);
    res.json({ success: true });
  });
  router.get('/queue', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT n.id,n.roll_number,n.text,n.created_at,n.approved_at,n.status,n.reported,
              s.name,s.course,s.section,s.year
       FROM spotlight_notes n JOIN spotlight_students s USING(roll_number)
       WHERE n.status='pending' OR n.reported=TRUE ORDER BY n.created_at, n.id`);
    res.json({ pending: rows.filter(n => n.status === 'pending'), reported: rows.filter(n => n.reported) });
  }));
  router.get('/students', wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const { rows } = await pool.query(
      `SELECT ${fields}, hidden FROM spotlight_students
       WHERE ($1='' OR name ILIKE $2 OR roll_number ILIKE $2)
       ORDER BY hidden DESC, name, roll_number LIMIT 50`, [q, `%${q}%`]);
    res.json({ students: rows });
  }));
  router.post('/notes/:id/:action', validateId, wrap(async (req, res) => {
    const action = req.params.action;
    if (!['approve', 'keep', 'reject', 'delete'].includes(action)) return res.status(404).json({ message: 'Action not found.' });
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
    if (!['hide', 'unhide'].includes(req.params.action)) return res.status(404).json({ message: 'Action not found.' });
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
