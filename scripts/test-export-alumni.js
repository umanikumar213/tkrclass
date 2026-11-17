'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { readRolls, parseProfile, collectStudent, options } = require('./export-alumni');

async function main() {
  const roll = '99K91A0001'; // synthetic fixture
  const html = `<html><body><table>
    <tr><td>Student Name:</td><td>Test Student</td><td>Roll No:</td><td>${roll}</td></tr>
    <tr><td>Course:</td><td>B.Tech</td><td>Section:</td><td>A</td></tr>
    <tr><td>Year of Study:</td><td>IV</td><td>Father Name:</td><td>Do not export</td></tr>
    </table><p>Email: private@example.invalid</p><img src="/photo.jpg"></body></html>`;
  assert.deepEqual(readRolls(`\uFEFF# approved list\n${roll}\n${roll.toLowerCase()}\n`), [roll]);
  assert.throws(() => readRolls('bad-entry'));
  assert.throws(() => options(['--delay-ms', '1']));
  const parsed = parseProfile(html, roll);
  assert.deepEqual(parsed, { name: 'Test Student', roll_number: roll, course: 'B.Tech', section: 'A', year: 'IV' });
  assert.throws(() => parseProfile(html, '99K91A0002'), /does not match/);
  const missing = parseProfile(`<body>Name: Test Student\nRoll No: ${roll}\n</body>`, roll);
  assert.equal(missing.section, '');
  assert.equal(missing.course, '');
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
      assert.equal(data.get('username'), roll);
      assert.equal(data.get('password'), roll);
      assert.equal(data.get('csrf'), 'fixture');
      if (mode === 'invalid') { res.end('<script>alert("Invalid Details")</script>'); return; }
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
  try {
    assert.deepEqual(await collectStudent(roll, config), parsed);
    assert.equal(logins, 1);
    assert.equal(photos, 0);
    mode = 'invalid';
    await assert.rejects(collectStudent(roll, config), /Login rejected/);
    assert.equal(logins, 2);
    mode = 'blocked';
    await assert.rejects(collectStudent(roll, config), /HTTP 429/);
    assert.equal(logins, 2);
    await assert.rejects(collectStudent(roll, { ...config, allowHttp: false }), /unencrypted HTTP/);
    console.log('PASS: list parsing, exact five-field extraction, missing/mismatched fields, local login/session flow, no photo fetch, rejected login, throttling stop, HTTP safeguard.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
