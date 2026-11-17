'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readRolls, parseProfile, collectStudent, options, runExport } = require('./export-alumni');

async function main() {
  const roll = '99K91A0001'; // synthetic fixture
  const html = `<html><body><table>
    <tr><td>Student Name:</td><td>Test Student</td><td>Roll No:</td><td>${roll}</td></tr>
    <tr><td>Course:</td><td>B.Tech</td><td>Section:</td><td>A</td></tr>
    <tr><td>Year of Study:</td><td>IV</td><td>Father Name:</td><td>Do not export</td></tr>
    </table><p>Email: private@example.invalid</p><img src="/photo.jpg"></body></html>`;
  assert.deepEqual(readRolls(`\uFEFF# approved list\n${roll}\n${roll.toLowerCase()}\n`), [roll]);
  assert.throws(() => readRolls('bad-entry'));
  const expanded = readRolls('# authorized series\n99K91A00\n99k91a00\n99K91A0001\n');
  assert.equal(expanded.length, 360);
  assert.equal(expanded[0], '99K91A0000');
  assert.equal(expanded[99], '99K91A0099');
  assert.equal(expanded[100], '99K91A00A0');
  assert.ok(expanded.includes('99K91A00A1'));
  assert.equal(expanded[359], '99K91A00Z9');
  assert.equal(readRolls('99K91A00\n98K91A00').length, 720);
  assert.throws(() => readRolls('99K91A000'));
  assert.throws(() => options(['--delay-ms', '1']));
  const parsed = parseProfile(html, roll);
  assert.deepEqual(parsed, { name: 'Test Student', roll_number: roll, course: 'B.Tech', section: 'A', year: 'IV' });
  assert.throws(() => parseProfile(html, '99K91A0002'), /does not match/);
  const missing = parseProfile(`<body>Name: Test Student\nRoll No: ${roll}\n</body>`, roll);
  assert.equal(missing.section, '');
  assert.equal(missing.course, '');
  const inlineProfile = `<body><table><tr><td>Section</td><td>Status</td><td>Year</td><td>Semester</td></tr></table>
    <div><b>Roll No:</b> ${roll} <b>Name:</b> Test Student <b>Father Name:</b> Do not export</div>
    <div><b>Course:</b> B.Tech. (CD) <b>Year:</b> B.Tech. V Semester (R22) <b>Section:</b> C</div></body>`;
  const profileValues = parseProfile(inlineProfile, roll);
  assert.equal(profileValues.section, 'C');
  assert.equal(profileValues.year, 'B.Tech. V Semester (R22)');
  assert.equal(profileValues.course, 'B.Tech. (CD)');
  assert.equal(profileValues.name, 'Test Student');
  const headingsOnly = parseProfile(`<body>Roll No: ${roll}\n<table><tr><td>Section</td><td>Status</td><td>Year</td><td>Semester</td></tr></table></body>`, roll);
  assert.equal(headingsOnly.section, '');
  assert.equal(headingsOnly.year, '');
  let mode = 'success';
  let logins = 0;
  let photos = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/portal/' && req.method === 'GET') {
      if (mode === 'blocked') { res.writeHead(429); res.end('Slow down'); return; }
      res.end('<form action="login" method="post"><input name="username"><input name="password" type="password"><input type="hidden" name="csrf" value="fixture"></form>');
    } else if (req.url === '/portal/login') {
      logins++;
      let text = '';
      for await (const chunk of req) text += chunk;
      const data = new URLSearchParams(text);
      const submittedRoll = data.get('username');
      assert.ok([roll, '99K91A0002'].includes(submittedRoll));
      assert.equal(data.get('password'), submittedRoll);
      assert.equal(data.get('csrf'), 'fixture');
      if (mode === 'invalid' || (mode === 'mixed' && submittedRoll === '99K91A0002')) { res.end('<script>alert("Invalid Details")</script>'); return; }
      res.setHeader('Set-Cookie', 'fixture_session=one; Path=/');
      res.end('<script>document.location="MainFrameset.php";</script>');
    } else if (req.url === '/portal/MainFrameset.php') {
      assert.ok(req.headers.cookie.includes('fixture_session=one'));
      res.end('<frame src="StudentInformationForStudent.php">');
    } else if (req.url === '/portal/StudentInformationForStudent.php') {
      assert.ok(req.headers.cookie.includes('fixture_session=one'));
      res.end(html);
    } else if (req.url === '/photo.jpg') {
      photos++; res.end('not fetched');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { base: `http://127.0.0.1:${server.address().port}/portal/`, allowHttp: true, requestDelay: 5 };
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'alumni-skip-test-'));
  try {
    assert.deepEqual(await collectStudent(roll, config), parsed);
    assert.equal(logins, 1);
    assert.equal(photos, 0);
    mode = 'invalid';
    await assert.rejects(collectStudent(roll, config), { code: 'INVALID_DETAILS' });
    assert.equal(logins, 2);
    mode = 'blocked';
    await assert.rejects(collectStudent(roll, config), /HTTP 429/);
    assert.equal(logins, 2);
    await assert.rejects(collectStudent(roll, { ...config, allowHttp: false }), /unencrypted HTTP/);
    mode = 'mixed';
    await runExport(['99K91A0002', roll], { ...config, output, delay: 0 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'skipped-rolls.json'), 'utf8')),
      [{ roll_number: '99K91A0002', reason: 'Invalid Details' }]);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'students.json'), 'utf8'))[0].roll_number, roll);
    assert.ok((await fs.readFile(path.join(output, 'students.csv'), 'utf8')).includes('Test Student'));
    const beforeResume = logins;
    await runExport(['99K91A0002', roll], { ...config, output, delay: 0 });
    assert.equal(logins, beforeResume);
    // Simulate the old bad checkpoint and a Windows CSV lock without student portal traffic.
    const damaged = { ...parsed, section: 'Status', year: 'Semester' };
    await fs.writeFile(path.join(output, 'students.json'), JSON.stringify([damaged]));
    const realRename = fs.rename;
    try {
      fs.rename = async (from, to) => {
        if (to.endsWith('students.csv')) {
          const error = new Error('Simulated Windows Excel lock');
          error.code = 'EPERM'; throw error;
        }
        return realRename(from, to);
      };
      await runExport([roll], { ...config, output, delay: 0 });
      const repaired = JSON.parse(await fs.readFile(path.join(output, 'students.json'), 'utf8'));
      assert.equal(repaired[0].section, 'A');
      assert.equal(repaired[0].year, 'IV');
      assert.ok((await fs.readdir(output)).some(file => file.startsWith('students-before-repair-')));
    } finally { fs.rename = realRename; }
    const beforeCsvRebuild = logins;
    await runExport([roll], { ...config, output, delay: 0 });
    assert.equal(logins, beforeCsvRebuild);
    const refreshedCsv = await fs.readFile(path.join(output, 'students.csv'), 'utf8');
    assert.ok(!refreshedCsv.includes('Status'));
    assert.ok(refreshedCsv.includes('"IV"'));
    mode = 'blocked';
    await assert.rejects(runExport(['99K91A0003'], { ...config, output, delay: 0 }), /HTTP 429/);
    console.log('PASS: explicit profile values override headings; bad checkpoint backup/repair; CSV lock recovery; five-field export; skip/resume; blocking safeguards.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(output, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
