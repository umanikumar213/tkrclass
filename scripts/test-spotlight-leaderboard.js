const assert = require('node:assert/strict');

async function runLeaderboardChecks({ request, save, loader }) {
  require('./test-spotlight-counts').runCountChecks();
  const redirect = await request('/leaderboard', { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.response.headers.get('location'), '/spotlight/leaderboard');
  const discover = await request('/spotlight');
  assert.doesNotMatch(discover.body, /id="leaderboard"|data-leader-tab|leaderboard_title|leader-heading/);
  assert.match(discover.body, /href="\/spotlight\/leaderboard"/);
  const board = await request('/spotlight/leaderboard?tab=liked');
  assert.equal(board.status, 200, 'Leaderboard must be routed before the dynamic profile route');
  assert.equal(board.response.headers.get('cache-control'), 'no-store');
  assert.match(board.body, /property="og:title" content="Campus Leaderboard · TKR Spotlight"/);
  assert.match(board.body, /property="og:url" content="https:\/\/spotlight\.example\/spotlight\/leaderboard"/);
  assert.match(board.body, /data-spotlight-page="leaderboard"/);
  assert.equal((board.body.match(/data-leader-tab=/g) || []).length, 3);
  const settings = (await request('/api/spotlight/admin/settings', { admin: true })).body;
  for (const key of ['leaderboard_page_title', 'filter_year_label', ...[1, 2, 3, 4].flatMap(n => [`year_label_${n}`, `year_short_${n}`])]) {
    assert.ok(settings.fields.some(field => field.key === key), `${key} must be editable in Content`);
  }
  assert.equal((await save({ leaderboard_page_title: 'Board "Now" <Students> & Friends' })).status, 200);
  const edited = await request('/spotlight/leaderboard');
  assert.match(edited.body, /content="Board &quot;Now&quot; &lt;Students&gt; &amp; Friends"/);
  assert.match(edited.body, /<title[^>]*>Board &quot;Now&quot; &lt;Students&gt; &amp; Friends<\/title>/);
  await save({ leaderboard_page_title: null });
  const { lists, boards, profiles } = loader.load('lib/spotlight-store.js');
  assert.equal(lists.ttl, 60000);
  assert.equal(boards.ttl, 120000);
  assert.equal(profiles.ttl, 300000, 'Profile cache policy otherwise stays unchanged');
  for (const [cache, ttl] of [[lists, 60000], [boards, 120000]]) {
    const start = Date.now();
    cache.set('ttl-test', { test: true });
    const expiry = cache.entries.get('ttl-test').expires;
    assert.ok(expiry >= start + ttl && expiry <= Date.now() + ttl);
    cache.entries.get('ttl-test').expires = Date.now() - 1;
    assert.equal(cache.get('ttl-test'), undefined);
  }
  console.log('PASS: dedicated leaderboard, permanent redirect, editable escaped OG tags, and 60/120-second cache expiration.');
}
module.exports = { runLeaderboardChecks };
