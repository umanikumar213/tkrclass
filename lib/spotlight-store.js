const pool = require('../db');
const { SpotlightCache } = require('./spotlight-cache');

const fields = 'roll_number, name, course, section, year, like_count, note_count';
const lists = new SpotlightCache({ ttl: 60000, bytes: 5 * 1024 * 1024 });
const profiles = new SpotlightCache({ bytes: 5 * 1024 * 1024 });
const boards = new SpotlightCache({ ttl: 120000, max: 3 });
const filters = new SpotlightCache({ ttl: 3600000, max: 1 });
const notesFeed = new SpotlightCache({ ttl: 60000, max: 30, bytes: 5 * 1024 * 1024 });
function clearSpotlightCaches() {
  lists.clear(); profiles.clear(); boards.clear(); filters.clear(); notesFeed.clear();
}
function clearProfile(roll) { profiles.invalidate(roll); }
function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function lockStudent(client, roll, allowHidden = false) {
  const { rows } = await client.query(
    `SELECT roll_number, hidden FROM spotlight_students WHERE roll_number=$1 FOR UPDATE`, [roll]);
  if (!rows.length || (!allowHidden && rows[0].hidden)) fail(404, 'student_missing');
  return rows[0];
}
async function lockNote(client, id, publicOnly = false) {
  // Consistent lock order for like, note, moderation, and reaction transactions.
  const first = await client.query('SELECT roll_number FROM spotlight_notes WHERE id=$1', [id]);
  if (!first.rows.length) fail(404, 'note_missing');
  const roll = first.rows[0].roll_number;
  await lockStudent(client, roll, !publicOnly);
  const { rows } = await client.query('SELECT * FROM spotlight_notes WHERE id=$1 FOR UPDATE', [id]);
  if (!rows.length || (publicOnly && rows[0].status !== 'approved')) {
    fail(404, 'note_missing');
  }
  return rows[0];
}
async function publicProfile(roll) {
  let data = profiles.get(roll);
  if (data !== undefined) return data;
  const revision = profiles.revision;
  const result = await pool.query(`SELECT ${fields} FROM spotlight_students WHERE roll_number=$1 AND hidden=FALSE`, [roll]);
  if (!result.rows.length) return null;
  const notes = await pool.query(
    `SELECT id, text, created_at, approved_at, react_heart, react_laugh, react_fire
     FROM spotlight_notes WHERE roll_number=$1 AND status='approved'
     ORDER BY (react_heart+react_laugh+react_fire) DESC, created_at DESC, id DESC`, [roll]);
  data = { student: result.rows[0], notes: notes.rows };
  if (profiles.revision === revision) profiles.set(roll, data);
  return data;
}

module.exports = {
  fields, lists, profiles, boards, filters, notesFeed, clearSpotlightCaches, clearProfile,
  fail, transaction, lockStudent, lockNote, publicProfile,
};
