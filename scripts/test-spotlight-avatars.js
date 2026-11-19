const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');
const sharp = require('sharp');

async function runAvatarChecks({ first, noPhoto, db, loader, request, post, directory }) {
  const style = loader.load('lib/spotlight-avatars.js');
  const media = loader.load('lib/spotlight-media.js');
  const before = (await db.query('SELECT * FROM spotlight_students ORDER BY roll_number')).rows;
  const snapshot = () => db.query('SELECT * FROM spotlight_students ORDER BY roll_number');
  const sameExceptGroup = (rows, originals) => {
    const omit = rows => rows.map(({ avatar_group, ...rest }) => rest);
    assert.deepEqual(omit(rows), omit(originals), 'No other student column may change');
  };
  const url = `/api/spotlight/avatar/${noPhoto}.svg`;
  const initial = await request(url);
  assert.equal(initial.status, 200);
  assert.match(initial.response.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(initial.response.headers.get('cache-control'), 'public, max-age=604800, immutable');
  assert.equal((await request(url)).body, initial.body);
  media.invalidateStudentMedia(noPhoto, false);
  assert.equal((await request(url)).body, initial.body, 'Regeneration is byte-identical');
  assert.notEqual((await request(`/api/spotlight/avatar/${first}.svg`)).body, initial.body);
  assert.equal((await request(url, { headers: { 'If-None-Match': initial.response.headers.get('etag') } })).status, 304);
  assert.ok((await style.generateAvatar(noPhoto, 'neutral')).equals(await style.generateAvatar(noPhoto, 'neutral')));
  assert.notDeepEqual(Array.from(style.avatarOptions(noPhoto, 'male').hair), Array.from(style.avatarOptions(noPhoto, 'female').hair));
  assert.notDeepEqual(Array.from(style.avatarOptions(noPhoto, 'neutral').hair), Array.from(style.avatarOptions(noPhoto, 'male').hair));
  assert.doesNotMatch(initial.body, /avatar_group|gender|\bfemale\b|\bmale\b/i);
  assert.equal((await request('/api/spotlight/avatar/26K91A9999.svg')).status, 404);
  assert.equal((await post(`/api/spotlight/admin/students/${noPhoto}/avatar`, { body: { avatar_group: 'female' } })).status, 401);
  assert.equal((await post(`/api/spotlight/admin/students/${noPhoto}/avatar`, { admin: true, body: { avatar_group: 'unknown' } })).status, 400);
  const oldOg = (await request(`/api/spotlight/og/${noPhoto}.jpg`)).response;
  // The request helper reads the body as text, so fetch image bytes separately.
  const generated = await media.getOg(noPhoto);
  const expected = await sharp(Buffer.from(initial.body)).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  assert.ok(generated.equals(expected), 'Missing-photo OG uses the generated avatar');
  assert.equal(oldOg.status, 200);
  const update = await post(`/api/spotlight/admin/students/${noPhoto}/avatar`, { admin: true, body: { avatar_group: 'female' } });
  assert.equal(update.status, 200);
  assert.match(update.body.avatar_url, new RegExp(`^/api/spotlight/avatar/${noPhoto}\\.svg\\?v=[a-f0-9]+$`));
  const changed = await request(url);
  assert.notEqual(changed.body, initial.body, 'Admin change invalidates the SVG cache');
  assert.ok(!(await media.getOg(noPhoto)).equals(generated), 'Admin change invalidates the OG cache');
  assert.equal((await sharp(await media.getOg(noPhoto)).metadata()).width, 400);
  sameExceptGroup((await snapshot()).rows, before);
  await post(`/api/spotlight/admin/students/${noPhoto}/hide`, { admin: true });
  assert.equal((await request(url)).status, 404, 'Cached avatars cannot bypass a hidden student');
  assert.equal((await request(url, { headers: { 'If-None-Match': changed.response.headers.get('etag') } })).status, 404);
  await post(`/api/spotlight/admin/students/${noPhoto}/avatar`, { admin: true, body: { avatar_group: 'male' } });
  assert.equal((await request(url)).status, 404, 'Changing a hidden student’s group must not unhide it');
  await post(`/api/spotlight/admin/students/${noPhoto}/unhide`, { admin: true });
  assert.equal((await request(url)).status, 200);
  const privateResult = await request(`/api/spotlight/admin/students?q=${noPhoto}`, { admin: true });
  assert.equal(privateResult.body.students[0].avatar_group, 'male');
  assert.equal(privateResult.body.texts.avatar_style_male, 'Male');
  for (const endpoint of ['/api/spotlight/texts', '/api/spotlight/config', '/api/spotlight/filters', '/api/spotlight/students',
    `/api/spotlight/students/${noPhoto}`, '/api/spotlight/leaderboard?tab=liked', '/api/spotlight/leaderboard?tab=noted']) {
    const json = JSON.stringify((await request(endpoint)).body);
    assert.doesNotMatch(json, /"(?:avatar_group|gender|avatar_style_male|avatar_style_female)"\s*:/, `Private group leaked through ${endpoint}`);
  }
  assert.doesNotMatch((await request(`/spotlight/${noPhoto}`)).body, /avatar_group|\bFemale\b|\bMale\b/);
  const baseline = (await snapshot()).rows;
  const file = path.join(directory, 'genders.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { roll_number: ` ${first.toLowerCase()} `, gender: ' FEMALE ' },
    { roll_number: noPhoto, gender: 'male' },
    { roll_number: '26K91A0104', gender: 'unlisted' },
    { roll_number: '26K91A9999', gender: 'female' },
  ]), 'Genders');
  XLSX.writeFile(workbook, file);
  const importer = loader.load('scripts/import-genders.js');
  const summary = await importer.importGenders({ file, log() {} });
  assert.equal(summary.updated, 3);
  assert.deepEqual(Array.from(summary.unknownRollNumbers), ['26K91A9999']);
  assert.equal(JSON.stringify(summary.counts), JSON.stringify({ male: 1, female: 1, neutral: 1 }));
  const imported = (await snapshot()).rows;
  sameExceptGroup(imported, baseline);
  assert.equal(imported.find(row => row.roll_number === first).avatar_group, 'female');
  await importer.importGenders({ file, log() {} });
  assert.deepEqual((await snapshot()).rows, imported, 'Import is safe to repeat');
  // Restore only the synthetic fixtures touched by this test.
  for (const student of before) {
    await db.query('UPDATE spotlight_students SET avatar_group=$2 WHERE roll_number=$1', [student.roll_number, student.avatar_group]);
    media.invalidateStudentMedia(student.roll_number, student.hidden);
  }
  loader.load('lib/spotlight-store.js').clearSpotlightCaches();
  console.log('PASS: deterministic local avatars, ETags, private groups, OG rendering, hidden checks, admin invalidation and avatar-only gender import.');
}
module.exports = { runAvatarChecks };
