// Optional browser checks: node scripts/test-spotlight.js --browser
// Requires Playwright in the testing environment, not in the application's production dependencies.
const assert = require('node:assert/strict');

async function runBrowserChecks({ base, first, db, loader }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // No real network/font/Turnstile calls are necessary for these browser flows.
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.goto(`${base}/spotlight`);
    await page.locator('#studentGrid .sp-student').first().waitFor();
    assert.equal(await page.locator('#studentGrid .sp-student').count(), 30);
    assert.equal(await page.locator('#loadMore').isVisible(), true);
    await page.locator('#loadMore').click();
    await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 35);
    assert.equal(await page.locator('#loadMore').isVisible(), false);
    await page.locator('#filterSteps .sp-chip', { hasText: '1st Year' }).click();
    await page.locator('#filterSteps .sp-chip', { hasText: 'CIVIL' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 1);
    assert.equal(await page.locator('.sp-filter-label', { hasText: 'Section' }).count(), 0);
    await page.locator('#studentSearch').fill(first.toLowerCase());
    await page.waitForTimeout(350);
    await page.locator('#studentGrid .sp-student').first().click();
    await page.locator('[data-like-button]').waitFor();
    assert.equal(await page.locator('.sp-profile-name').textContent(), 'Student <Unsafe & "Name">');
    assert.equal(await page.locator('.sp-profile-name script').count(), 0);
    // Browser context has its own signed identity and a different IP from the integration fixture.
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#profileLikeCount').textContent(), '4');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    await page.locator('#noteText').fill('A kind browser test note');
    assert.equal(await page.locator('#noteCounter').textContent(), '24 / 200');
    await page.locator('#noteSubmit').click();
    await page.locator('#noteMessage.success').waitFor();
    assert.equal(await page.locator('#noteMessage').textContent(), 'Your note will appear after review.');
    const note = (await db.query(`SELECT id FROM spotlight_notes WHERE text='A kind browser test note'`)).rows[0];
    assert.ok(note);
    await page.locator('button', { hasText: 'Share profile' }).click();
    // Chromium may expose navigator.share in some environments; inspect fallback when present.
    if (await page.locator('[role=dialog]').count()) {
      assert.ok((await page.locator('a', { hasText: 'WhatsApp' }).getAttribute('href')).startsWith('https://wa.me/?text='));
      await page.locator('[role=dialog] button', { hasText: 'Close' }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const adminPage = await context.newPage();
    adminPage.on('pageerror', error => errors.push(error.message));
    await adminPage.goto(`${base}/spotlight/admin`);
    await adminPage.locator('#adminPassword').fill(loader.env.ADMIN_PASSWORD);
    await adminPage.locator('#adminLoginButton').click();
    await adminPage.locator('#adminView:not([hidden])').waitFor();
    const card = adminPage.locator('.sp-admin-note', { hasText: 'A kind browser test note' });
    await card.locator('button', { hasText: 'Approve' }).click();
    await card.waitFor({ state: 'detached' });
    await page.reload();
    const publicNote = page.locator(`[data-note-id="${note.id}"]`);
    await publicNote.waitFor();
    await publicNote.locator('[data-reaction=heart]').click();
    await publicNote.locator('[data-reaction=heart].is-selected').waitFor();
    await page.reload();
    await page.locator(`[data-note-id="${note.id}"] [data-reaction=heart].is-selected`).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-note-id="${note.id}"] [data-report]`).click();
    await page.locator(`[data-note-id="${note.id}"]`).waitFor({ state: 'detached' });
    await adminPage.locator('[data-admin-tab=reported]').click();
    const report = adminPage.locator('.sp-admin-note', { hasText: 'A kind browser test note' });
    await report.locator('button', { hasText: 'Keep note' }).click();
    await report.waitFor({ state: 'detached' });
    await adminPage.locator('[data-admin-tab=students]').click();
    await adminPage.locator('#adminContent input').fill(first);
    await adminPage.locator(`[data-roll="${first}"]`).waitFor();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=hide]`).click();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=unhide]`).waitFor();
    await page.reload();
    await page.getByText('This profile is not available', { exact: true }).first().waitFor();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=unhide]`).click();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=hide]`).waitFor();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'false');
    await adminPage.locator('#adminLogout').click();
    await adminPage.locator('#adminLoginView:not([hidden])').waitFor();
    assert.equal(await adminPage.locator('#adminPassword').inputValue(), '');
    assert.equal(await adminPage.evaluate(() => sessionStorage.length + localStorage.length), 0);
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS: phone browser discovery, pagination, safe text, persistent likes/reactions, note review, reporting, sharing, visibility controls, and logout.');
  } finally { await browser.close(); }
}
module.exports = { runBrowserChecks };
