const assert = require('node:assert/strict');

async function checkPublicNavigation(page, kind) {
  const mobile = page.viewportSize().width < 680;
  for (const selector of ['.sp-bottom-nav', '.sp-desktop-nav']) {
    const nav = page.locator(selector);
    const order = await nav.locator(':scope > :is(a,button)').evaluateAll(nodes =>
      nodes.map(node => node.tagName === 'BUTTON' ? 'random' : new URL(node.href).pathname));
    assert.deepEqual(order, ['/spotlight', '/spotlight/leaderboard', '/spotlight/notes', '/']);
    assert.equal(await nav.locator('[data-sp-text=leaderboard_nav_emoji]').textContent(), '🏆');
    assert.equal(await nav.locator('[data-sp-text=notes_nav_emoji]').textContent(), '💌');
    assert.equal(await nav.isVisible(), selector === '.sp-bottom-nav' ? mobile : !mobile);
    const current = nav.locator('[aria-current="page"]');
    assert.equal(await current.count(), 1);
    assert.equal(await current.getAttribute('href'), kind === 'leaderboard' ? '/spotlight/leaderboard' : kind === 'notes' ? '/spotlight/notes' : '/spotlight');
  }
  if (mobile) {
    const nav = await page.locator('.sp-bottom-nav').boundingBox();
    assert.ok(Math.abs(nav.y + nav.height - page.viewportSize().height) <= 1);
    const padding = await page.locator('.sp-shell').evaluate(node => parseFloat(getComputedStyle(node).paddingBottom));
    assert.ok(padding > nav.height, 'Content needs room above bottom navigation');
    if (kind === 'profile') {
      const actions = await page.locator('.sp-profile-actions').boundingBox();
      const note = await page.locator('#openNoteComposer').boundingBox();
      assert.ok(actions.y + actions.height <= nav.y + 1, 'Like/share actions cannot cover navigation');
      assert.ok(note.y + note.height < actions.y, 'Note button cannot cover like/share actions');
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '34px'));
      const safeNav = await page.locator('.sp-bottom-nav').boundingBox();
      const safeActions = await page.locator('.sp-profile-actions').boundingBox();
      assert.ok(safeNav.height >= 96, 'Simulated iPhone safe area needs 34px extra room');
      assert.ok(safeActions.y + safeActions.height <= safeNav.y + 1);
      await page.evaluate(() => document.documentElement.style.removeProperty('--safe-bottom'));
    }
  }
}

async function checkLeaderboardPage({ page, base, checkPage, screenshot, label }) {
  await page.goto(`${base}/spotlight/leaderboard`);
  await page.waitForURL('**/spotlight/leaderboard?tab=liked');
  await page.locator('#leaderboard a').first().waitFor();
  await checkPage(page, `Leaderboard ${label}`);
  await checkPublicNavigation(page, 'leaderboard');
  assert.equal(await page.locator('[data-leader-tab=liked]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await page.locator('[data-leader-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.leaderTab)), ['liked', 'noted', 'trending']);
  const ranks = page.locator('.sp-podium-card');
  assert.deepEqual(await ranks.evaluateAll(nodes => nodes.map(node => Number(node.className.match(/sp-podium-rank-(\d)/)[1]))), [2, 1, 3]);
  const positions = await ranks.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  const avatarWidths = await ranks.locator('.sp-avatar').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(avatarWidths[1] > avatarWidths[0] && avatarWidths[1] > avatarWidths[2]);
  assert.equal(await page.locator('.sp-podium').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  const rows = page.locator('.sp-leader');
  assert.equal(await rows.count(), 17, 'Podium plus list must respect the default twenty-person cap');
  assert.equal((await rows.first().locator('.sp-avatar').boundingBox()).width, 48);
  assert.equal(await rows.first().locator('.sp-avatar').evaluate(node => getComputedStyle(node).borderRadius), '50%');
  assert.equal(await rows.first().locator('.sp-leader-rank').textContent(), '4');
  assert.ok((await rows.first().locator('.sp-leader-count small').textContent()).trim().length > 0);
  await screenshot(page, `leaderboard-${label}`);
  await page.evaluate(() => scrollTo(0, 320));
  const tabs = await page.locator('.sp-leader-tabs').boundingBox();
  const header = await page.locator('.sp-topbar').boundingBox();
  assert.ok(Math.abs(tabs.y - header.y - header.height) <= 2, 'Tabs must stick immediately below the header');
  await page.locator('[data-leader-tab=trending]').click();
  await page.waitForURL('**/spotlight/leaderboard?tab=trending');
  await page.locator('#leaderboard a').first().waitFor();
  await page.goBack();
  await page.waitForURL('**/spotlight/leaderboard?tab=liked');
  await page.locator('#leaderboard a').first().waitFor();
  assert.equal(await page.locator('[data-leader-tab=liked]').getAttribute('aria-selected'), 'true');
  await page.reload();
  await page.locator('#leaderboard a').first().waitFor();
  assert.equal(await page.locator('[data-leader-tab=liked]').getAttribute('aria-selected'), 'true');
  await page.route('**/api/spotlight/leaderboard?tab=noted', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"students":[]}' }));
  await page.locator('[data-leader-tab=noted]').click();
  await page.locator('#leaderboard .sp-state').waitFor();
  const content = await (await page.request.get(`${base}/api/spotlight/texts`)).json();
  assert.equal(await page.locator('#leaderboard .sp-state strong').textContent(), content.texts.leader_empty);
  await page.unroute('**/api/spotlight/leaderboard?tab=noted');
}
module.exports = { checkPublicNavigation, checkLeaderboardPage };
