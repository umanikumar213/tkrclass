const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testPerformance({ load, pool, request, json, approved, night, admin }) {
  const { FeedCache, feedPage } = load('lib/feed-cache.js');
  const cache = new FeedCache();
  for (let i = 0; i < 201; i++) cache.set(i, { value: i });
  assert.equal(cache.size, 200);
  assert.equal(cache.get(0), null);
  assert.equal(cache.get(200).value, 200);
  cache.set(200, { value: 'replaced' }); assert.equal(cache.size, 200);
  assert.equal(cache.get(1).value, 1);
  const expired = new FeedCache(-1); expired.set('old', {});
  assert.equal(expired.get('old'), null); assert.equal(expired.size, 0);
  assert.equal(feedPage('200').beyondLimit, false);
  for (const input of ['201', '9999999999999999999999999', '9'.repeat(400)]) assert.equal(feedPage(input).beyondLimit, true);

  const originalQuery = pool.query;
  let feedQueries = 0;
  pool.query = function (...args) {
    if (/comment_count[\s\S]*FROM (?:confessions|reyi_posts)\s+WHERE/.test(String(args[0]))) feedQueries++;
    return originalQuery.apply(this, args);
  };
  try {
    for (const [prefix, id, emoji] of [['chat', approved, 'wow'], ['reyi', night, 'pleading']]) {
      let result = await request(`/api/${prefix}/posts?page=200`);
      assert.equal(result.status, 200);
      const queriesAtBoundary = feedQueries;
      for (const page of ['201', '10000000000000000000', '9'.repeat(400)]) {
        result = await request(`/api/${prefix}/posts?page=${page}`);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.posts, []);
        assert.equal(result.body.hasMore, false);
      }
      assert.equal(feedQueries, queriesAtBoundary, 'Pages over 200 must not query the database');
      const before = await request(`/api/${prefix}/posts`);
      const afterPrime = feedQueries;
      const reaction = await request(`/api/${prefix}/posts/${id}/react`, json({ emoji }, { ip: '10.9.1.1' }));
      assert.equal(reaction.status, 200);
      assert.equal(reaction.body.emoji, emoji);
      assert.equal(typeof reaction.body.counts[`react_${emoji}`], 'number');
      const cached = await request(`/api/${prefix}/posts`);
      assert.equal(feedQueries, afterPrime, 'Reaction must not discard the feed cache');
      assert.deepEqual(cached.body, before.body);
      assert.equal((await request(`/api/${prefix}/admin/unflag/${id}`, { method: 'POST', headers: admin })).status, 200);
      await request(`/api/${prefix}/posts`);
      assert.equal(feedQueries, afterPrime + 1, 'Admin action must invalidate the feed cache');
      const table = prefix === 'chat' ? 'confession_comments' : 'reyi_comments';
      const postColumn = prefix === 'chat' ? 'confession_id' : 'post_id';
      const comment = (await pool.query(`INSERT INTO ${table}(${postColumn},text) VALUES($1,'Review fixture') RETURNING id`, [id])).rows[0];
      assert.equal((await request(`/api/${prefix}/admin/approve-comment/${comment.id}`, { method: 'POST', headers: admin })).status, 200);
      await request(`/api/${prefix}/posts`);
      assert.equal(feedQueries, afterPrime + 2, 'Approved comment must invalidate the feed cache');
    }
  } finally { pool.query = originalQuery; }

  for (const id of [99999999, (await pool.query(`INSERT INTO confessions(text,status) VALUES('Hidden post','pending') RETURNING id`)).rows[0].id]) {
    const report = await request(`/api/chat/posts/${id}/report`, { method: 'POST', ip: '10.9.2.1' });
    assert.equal(report.status, 404); assert.equal(report.body.message, 'Post not found.');
    if (id !== 99999999) {
      await pool.query(`INSERT INTO confession_comments(confession_id,text,status) VALUES($1,'Not public','approved')`, [id]);
      assert.deepEqual((await request(`/api/chat/posts/${id}/comments`)).body.comments, []);
      await pool.query(`UPDATE confessions SET status='approved' WHERE id=$1`, [id]);
      assert.equal((await request(`/api/chat/posts/${id}/comments`)).body.comments.length, 1);
      assert.equal((await request(`/api/chat/posts/${id}/report`, { method: 'POST', ip: '10.9.2.1' })).status, 200);
    }
  }

  const { runMigration } = load('lib/migrations.js');
  await pool.query('CREATE TABLE migration_test_runs(value INTEGER)');
  await Promise.all(Array.from({ length: 5 }, () =>
    runMigration('test_concurrent_once', 'INSERT INTO migration_test_runs(value) VALUES(1)')));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM migration_test_runs')).rows[0].n, 1);
  await assert.rejects(runMigration('test_retry_after_failure', 'INSERT INTO table_that_does_not_exist VALUES(1)'));
  assert.equal((await pool.query("SELECT name FROM schema_migrations WHERE name='test_retry_after_failure'")).rowCount, 0);
  await runMigration('test_retry_after_failure', 'INSERT INTO migration_test_runs(value) VALUES(2)');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM migration_test_runs')).rows[0].n, 2);
  const migration = (await pool.query("SELECT applied_at FROM schema_migrations WHERE name='chat_text_limit_2500'")).rows[0];
  assert.ok(migration);
  await load('chat.js').initDb();
  assert.equal((await pool.query("SELECT applied_at FROM schema_migrations WHERE name='chat_text_limit_2500'")).rows[0].applied_at.toISOString(), migration.applied_at.toISOString());

  const { parseAttendanceSummary } = load('lib/attendance.js');
  const dump = 'Unrelated numbers 1 1 0 100%\nSubject Abrevation\nMAT\nPHY\nCons. Total\nAttendance\n8/10\n9/10\n20 17 3 85%';
  const parsed = parseAttendanceSummary(dump);
  assert.equal(parsed.summary.conducted, 20);
  assert.equal(parsed.overall, '85');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.perSubject)), [{ subject: 'MAT', attended: '8/10' }, { subject: 'PHY', attended: '9/10' }]);
  assert.equal(parseAttendanceSummary(dump.replace('9/10\n', '')).perSubject.length, 0);
  assert.equal(parseAttendanceSummary('1 1 0 100%').summary, null);
  assert.equal(parseAttendanceSummary('1 1 0 100%').overall, '');
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8').includes('\r'), false);
  console.log('PASS: feed page/cache caps, cache retention and admin/comment invalidation, report/comment visibility, one-time concurrent migrations, anchored summary parsing, and LF line endings.');
};
