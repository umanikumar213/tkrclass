const pool = require('../db');
const { notesFeed, fail } = require('./spotlight-store');
const { hiddenRolls } = require('./spotlight-media');

function parseFeedQuery(query) {
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d{0,5}$/.test(query.limit)) fail(400, 'feed_invalid_limit');
    limit = Math.min(30, Number(query.limit));
  }
  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 64) fail(400, 'feed_invalid_cursor');
    const match = query.cursor.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([1-9]\d{0,9})$/);
    if (!match) fail(400, 'feed_invalid_cursor');
    const date = new Date(match[1]);
    const id = Number(match[2]);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1
      || date.toISOString().slice(0, 19) !== match[1].slice(0, 19) || id > 2147483647) fail(400, 'feed_invalid_cursor');
    // Validate with Date, but keep PostgreSQL's original microseconds for the tuple comparison.
    cursor = { time: match[1], id };
  }
  return { limit, cursor };
}

async function getNotesFeed(req) {
  const { limit, cursor } = parseFeedQuery(req.query);
  const refresh = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(req.get('cache-control') || '');
  let page = !cursor && !refresh ? notesFeed.get(limit) : undefined;
  if (page === undefined) {
    const revision = notesFeed.revision;
    const { rows } = await pool.query(
      `SELECT n.id,n.text,
        to_char(n.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at,
        n.react_heart,n.react_laugh,n.react_fire,
        json_build_object('roll_number',s.roll_number,'name',s.name,'course',s.course,
          'section',s.section,'year',s.year,'has_photo',s.photo_data IS NOT NULL) AS student
       FROM spotlight_notes n JOIN spotlight_students s USING(roll_number)
       WHERE n.status='approved' AND n.approved_at IS NOT NULL AND s.hidden=FALSE
         AND ($1::timestamptz IS NULL OR (n.approved_at,n.id)<($1::timestamptz,$2::int))
       ORDER BY n.approved_at DESC,n.id DESC LIMIT $3`,
      [cursor?.time || null, cursor?.id || null, limit + 1]);
    const notes = rows.slice(0, limit);
    const tail = notes[notes.length - 1];
    page = { notes, nextCursor: rows.length > limit ? `${tail.approved_at}|${tail.id}` : null };
    if (!cursor && notesFeed.revision === revision) notesFeed.set(limit, page);
  }
  const notes = page.notes.filter(note => !hiddenRolls.has(note.student.roll_number));
  const ids = notes.map(note => note.id);
  const reactions = ids.length ? await pool.query(
    'SELECT note_id,emoji FROM spotlight_note_reactions WHERE voter_hash=$1 AND note_id=ANY($2::int[])',
    [req.voterHash, ids]) : { rows: [] };
  const mine = new Map(reactions.rows.map(row => [row.note_id, row.emoji]));
  return { notes: notes.filter(note => !hiddenRolls.has(note.student.roll_number))
    .map(note => ({ ...note, myReaction: mine.get(note.id) || null })), nextCursor: page.nextCursor };
}
module.exports = { parseFeedQuery, getNotesFeed };
