// Manual/offline import only. Never required by server.js.
const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');
const sharp = require('sharp');
const pool = require('../db');
const { initSpotlightSchema } = require('../lib/spotlight-db');

const root = path.resolve(__dirname, '..');
const rollPattern = /^[A-Z0-9]{8,12}$/;
const trim = value => String(value ?? '').trim();

async function importStudents({
  file = path.join(root, 'data/students.xlsx'),
  photosDir = path.join(root, 'data/photos'),
  log = console.log,
} = {}) {
  const workbook = XLSX.read(await fs.readFile(file), { type: 'buffer' });
  if (!workbook.SheetNames.length) throw new Error('The workbook has no worksheets.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false })[0] || [];
  const required = ['name', 'roll_number', 'course', 'section', 'year'];
  if (!required.every(column => header.map(trim).includes(column))) {
    throw new Error(`The first row must contain columns: ${required.join(', ')}.`);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const students = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = Object.fromEntries(Object.entries(rows[index]).map(([key, value]) => [key.trim(), trim(value)]));
    if (required.every(key => !row[key])) continue;
    const roll = (row.roll_number || '').toUpperCase();
    if (!rollPattern.test(roll) || !row.name || !row.course || !row.year) {
      throw new Error(`Invalid or incomplete student at spreadsheet row ${index + 2}; nothing was imported.`);
    }
    students.set(roll, { name: row.name, roll_number: roll, course: row.course.toUpperCase(), section: row.section || null, year: row.year });
  }
  if (!students.size) throw new Error('No student rows found; nothing was imported.');
  let entries;
  try { entries = await fs.readdir(photosDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  const photos = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.webp') continue;
    const roll = path.basename(entry.name, path.extname(entry.name)).toUpperCase();
    if (!rollPattern.test(roll)) throw new Error('A photo filename is not a valid roll number.');
    if (photos.has(roll)) throw new Error(`Duplicate photo filenames for ${roll}.`);
    photos.set(roll, path.join(photosDir, entry.name));
  }
  const unmatched = [...photos.keys()].filter(roll => !students.has(roll)).sort();
  const withoutPhoto = [...students.keys()].filter(roll => !photos.has(roll));
  // Validate and convert before opening the write transaction. No partial import on a bad photo.
  const prepared = [];
  for (const student of students.values()) {
    let photo = null;
    if (photos.has(student.roll_number)) {
      photo = await sharp(photos.get(student.roll_number), { limitInputPixels: 40000000 })
        .rotate().resize(200, 200, { fit: 'cover' }).webp({ quality: 70 }).toBuffer();
    }
    prepared.push({ ...student, photo });
  }
  await initSpotlightSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const student of prepared) {
      await client.query(
        `INSERT INTO spotlight_students(roll_number,name,course,section,year,photo_data)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(roll_number) DO UPDATE SET name=EXCLUDED.name,course=EXCLUDED.course,
           section=EXCLUDED.section,year=EXCLUDED.year,
           photo_data=COALESCE(EXCLUDED.photo_data,spotlight_students.photo_data),updated_at=NOW()`,
        [student.roll_number, student.name, student.course, student.section, student.year, student.photo]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const summary = {
    imported: students.size, photosMatched: students.size - withoutPhoto.length,
    photosWithoutStudent: unmatched, studentsWithoutPhoto: withoutPhoto.length,
  };
  log(`Students imported: ${summary.imported}`);
  log(`Photos matched: ${summary.photosMatched}`);
  log(`Photos with no matching student: ${unmatched.length}${unmatched.length ? ` (${unmatched.join(', ')})` : ''}`);
  log(`Students with no photo: ${withoutPhoto.length}`);
  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/import-students.js [--file data/students.xlsx] [--photos data/photos]');
    pool.end();
  } else {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--file', '--photos'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown option. Use --help.');
      options[args[i] === '--file' ? 'file' : 'photosDir'] = path.resolve(args[i + 1]);
    }
    importStudents(options).catch(error => {
      console.error('Import failed:', error.code || error.message);
      process.exitCode = 1;
    }).finally(() => pool.end());
  }
}
module.exports = { importStudents };
