const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runAvatarBrowserChecks({ context, page, adminPage, base, first, noPhoto }) {
  const select = adminPage.locator(`[data-avatar-roll="${first}"]`);
  await select.waitFor();
  const row = select.locator('xpath=ancestor::*[contains(@class,"sp-hidden-row")][1]');
  await select.selectOption('female');
  await adminPage.locator('#toast.show', { hasText: 'Avatar updated.' }).waitFor();
  assert.equal(await select.inputValue(), 'female');
  const preview = row.locator('.sp-admin-avatar-tools img');
  await adminPage.waitForFunction(roll => document.querySelector(`[data-avatar-roll="${roll}"]`)
    ?.closest('.sp-hidden-row').querySelector('.sp-admin-avatar-tools img')?.src.includes('?v='), first);
  assert.match(await preview.getAttribute('src'), /\/avatar\/.*\.svg\?v=[a-f0-9]+$/);
  assert.doesNotMatch(await preview.getAttribute('src'), /female|male|neutral/);
  const saved = await context.request.get(`${base}/api/spotlight/admin/students?q=${first}`);
  assert.equal((await saved.json()).students[0].avatar_group, 'female');
  assert.ok(await page.locator('.sp-avatar-large img').getAttribute('src').then(src => src.includes('/photo/')), 'Real profile photo is unchanged');
  await select.selectOption('neutral');
  await adminPage.waitForFunction(roll => !document.querySelector(`[data-avatar-roll="${roll}"]`)?.disabled, first);
  assert.equal((await (await context.request.get(`${base}/api/spotlight/admin/students?q=${first}`)).json()).students[0].avatar_group, 'neutral');
  const output = path.resolve(__dirname, '../generated-artifacts/spotlight-avatars');
  await fs.mkdir(output, { recursive: true });
  await adminPage.screenshot({ path: path.join(output, 'admin.png') });
  const avatarPage = await context.newPage();
  try {
    await avatarPage.goto(`${base}/spotlight/${noPhoto}`);
    await avatarPage.waitForFunction(() => {
      const image = document.querySelector('.sp-avatar-large img');
      return image?.src.includes('/avatar/') && image.complete && image.naturalWidth > 0;
    });
    assert.ok((await avatarPage.locator('.sp-avatar-large img').boundingBox()).width <= 120);
    assert.doesNotMatch(await avatarPage.locator('body').textContent(), /avatar_group|\bMale\b|\bFemale\b|\bNeutral\b/);
    await avatarPage.screenshot({ path: path.join(output, 'profile.png') });
    let failedRequests = 0;
    await avatarPage.route('**/api/spotlight/avatar/26K91A0104.svg', route => {
      failedRequests++;
      return route.fulfill({ status: 404, body: '' });
    });
    await avatarPage.goto(`${base}/spotlight/26K91A0104`);
    await avatarPage.waitForFunction(() => {
      const avatar = document.querySelector('.sp-profile-person > .sp-avatar');
      return avatar && !avatar.querySelector('img');
    });
    assert.ok((await avatarPage.locator('.sp-profile-person > .sp-avatar').textContent()).trim().length > 0);
    assert.equal(failedRequests, 1, 'Failed avatars must stop at initials, not retry forever');
  } finally { await avatarPage.close(); }
  console.log('PASS: missing-photo avatar and initials fallbacks, unchanged real photos, private admin controls and immediate preview updates.');
}
module.exports = { runAvatarBrowserChecks };
