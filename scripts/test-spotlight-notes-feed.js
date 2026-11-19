const assert = require('node:assert/strict');

async function runNotesFeedChecks({ request, post, db, loader, noPhoto }) {
  const store = loader.load('lib/spotlight-store.js');
  const inserted = await db.query(
    `INSERT INTO spotlight_notes(roll_number,text,ip_hash,status,created_at,approved_at)
     SELECT $1,'Feed fixture '||n,'private-feed-ip','approved','2019-01-01'::timestamptz,
       '2020-01-01'::timestamptz+(n%4)*INTERVAL '1 microsecond'
     FROM generate_series(1,53) n RETURNING id`, [noPhoto]);
  const pending = await db.query(
    `INSERT INTO spotlight_notes(roll_number,text,ip_hash,status)
     VALUES($1,'Feed pending fixture','private-feed-ip','pending') RETURNING id`, [noPhoto]);
  const ids = [...inserted.rows, ...pending.rows].map(row => row.id);
  const freshId = pending.rows[0].id;
  let approved = false;
  const feed = (options = {}, suffix = '') => request(`/api/spotlight/notes/feed${suffix}`, options);
  try {
    store.clearSpotlightCaches();
    const page = await request('/spotlight/notes');
    assert.equal(page.status, 200);
    assert.match(page.body, /property="og:url" content="https:\/\/spotlight\.example\/spotlight\/notes"/);
    assert.match(page.body, /property="og:title" content="Latest notes · TKR Spotlight"/);
    assert.equal(page.response.headers.get('cache-control'), 'no-store');
    const settings = (await request('/api/spotlight/admin/settings', { admin: true })).body;
    for (const key of ['notes_nav_label','notes_nav_emoji','notes_feed_page_title','notes_feed_title','notes_feed_subtitle',
      'notes_feed_empty','notes_feed_end','notes_feed_new','notes_feed_more','notes_feed_loading','notes_feed_error','notes_feed_retry','notes_feed_heart_emoji']) {
      assert.ok(settings.fields.some(field => field.key === key), `${key} must be editable`);
    }
    const index = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='spotlight_notes_feed'");
    assert.match(index.rows[0].indexdef, /status, approved_at DESC, id DESC/);
    const initial = await feed();
    assert.equal(initial.status, 200);
    assert.equal(initial.body.notes.length, 20);
    assert.equal(initial.response.headers.get('cache-control'), 'no-store');
    assert.ok(initial.body.nextCursor);
    assert.match(initial.body.nextCursor, /\.\d{6}Z\|\d+$/);
    const all = [...initial.body.notes];
    let cursor = initial.body.nextCursor;
    while (cursor) {
      const next = await feed({}, `?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(next.status, 200);
      all.push(...next.body.notes);
      cursor = next.body.nextCursor;
    }
    const expected = await db.query(
      `SELECT n.id FROM spotlight_notes n JOIN spotlight_students s USING(roll_number)
       WHERE n.status='approved' AND s.hidden=FALSE AND n.approved_at IS NOT NULL
       ORDER BY n.approved_at DESC,n.id DESC`);
    assert.deepEqual(all.map(note => note.id), expected.rows.map(note => note.id), 'No gaps or duplicates, including microsecond and exact timestamp ties');
    for (const note of all) {
      assert.deepEqual(Object.keys(note).sort(), ['approved_at','id','myReaction','react_fire','react_heart','react_laugh','student','text']);
      assert.deepEqual(Object.keys(note.student).sort(), ['course','has_photo','name','roll_number','section','year']);
      assert.equal(typeof note.student.has_photo, 'boolean');
    }
    for (const forbidden of ['ip_hash','voter_hash','reported','report_count','avatar_group','photo_data']) {
      assert.ok(!JSON.stringify(initial.body).includes(`"${forbidden}"`));
    }
    assert.equal((await feed({}, '?limit=100')).body.notes.length, 30);
    for (const suffix of ['?limit=0', '?limit=-1', '?limit=1.5', '?limit[]=20', '?cursor=bad',
      '?cursor=2020-02-30T00:00:00.000000Z%7C1', '?cursor=2020-01-01T00:00:00.000000Z%7C2147483648']) {
      assert.equal((await feed({}, suffix)).status, 400, suffix);
    }
    const target = initial.body.notes[0].id;
    const owner = initial.cookies;
    assert.equal((await post(`/api/spotlight/notes/${target}/react`, {
      cookie: owner, network: '198.51.100.230', body: { emoji: 'heart' },
    })).status, 200);
    const mine = (await feed({ cookie: owner })).body.notes.find(note => note.id === target);
    assert.equal(mine.myReaction, 'heart');
    const other = (await feed()).body.notes.find(note => note.id === target);
    assert.equal(other.myReaction, null, 'Shared first-page cache cannot leak visitor reactions');
    assert.equal(store.notesFeed.get(20).notes[0].myReaction, undefined);
    await post(`/api/spotlight/notes/${target}/react`, {
      cookie: owner, network: '198.51.100.230', body: { emoji: 'heart' },
    });
    await feed();
    assert.equal((await post(`/api/spotlight/admin/notes/${freshId}/approve`, { admin: true })).status, 200);
    approved = true;
    assert.equal(store.notesFeed.get(20), undefined);
    assert.equal((await feed()).body.notes[0].id, freshId, 'New approval must be immediately first');
    await post(`/api/spotlight/notes/${freshId}/report`, { cookie: owner, network: '198.51.100.231' });
    assert.equal((await feed()).body.notes[0].id, freshId, 'Reports cannot hide approved notes');
    await post(`/api/spotlight/admin/notes/${freshId}/keep`, { admin: true });
    assert.equal(store.notesFeed.get(20), undefined);
    assert.equal((await feed()).body.notes[0].id, freshId);
    await post(`/api/spotlight/admin/students/${noPhoto}/hide`, { admin: true });
    assert.equal(store.notesFeed.get(20), undefined);
    assert.ok((await feed()).body.notes.every(note => note.student.roll_number !== noPhoto));
    await post(`/api/spotlight/admin/students/${noPhoto}/unhide`, { admin: true });
    assert.equal(store.notesFeed.get(20), undefined);
    assert.equal((await feed()).body.notes[0].id, freshId);
    await post(`/api/spotlight/admin/notes/${freshId}/delete`, { admin: true });
    approved = false;
    assert.equal(store.notesFeed.get(20), undefined);
    assert.ok(!(await feed()).body.notes.some(note => note.id === freshId));
    assert.equal(store.notesFeed.ttl, 60000);
    const rateOptions = { network: '198.51.100.233', cookie: owner };
    for (let i = 0; i < 120; i++) assert.equal((await feed(rateOptions, '?limit=1')).status, 200);
    assert.equal((await feed(rateOptions, '?limit=1')).status, 429);
    console.log('PASS: approved-only feed, microsecond-safe keyset pagination, private reactions, hidden checks, admin invalidation, rate limits and OG tags.');
  } finally {
    if (approved) await post(`/api/spotlight/admin/notes/${freshId}/delete`, { admin: true });
    await db.query('DELETE FROM spotlight_notes WHERE id=ANY($1::int[])', [ids]);
    store.clearSpotlightCaches();
  }
}
module.exports = { runNotesFeedChecks };
