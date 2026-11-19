// Manual, private input only. This script never runs as part of server startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');
const pool = require('../db');
const { normalizeGroup } = require('../lib/spotlight-avatars');

async function importGenders({ file = path.resolve(__dirname, '../data/genders.xlsx'), log = console.log } = {}) {
  const workbook = XLSX.read(await fs.readFile(file), { type: 'buffer' });
  if (!workbook.SheetNames.length) throw new Error('The workbook has no worksheets.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false });
  const headers = (table.shift() || []).map(value => String(value).trim().toLowerCase());
  const rollIndex = headers.indexOf('roll_number'), genderIndex = headers.indexOf('gender');
  if (rollIndex < 0 || genderIndex < 0) throw new Error('The first row must contain roll_number and gender.');
  const entries = new Map();
  for (const row of table) {
    if (row.every(value => !String(value).trim())) continue;
    const roll = String(row[rollIndex] ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/.test(roll)) throw new Error('Invalid roll number; nothing was imported.');
    entries.set(roll, normalizeGroup(row[genderIndex]));
  }
  if (!entries.size) throw new Error('No roll numbers found; nothing was imported.');
  const summary = { updated: 0, unknownRollNumbers: [], counts: { male: 0, female: 0, neutral: 0 } };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [roll, group] of entries) {
      const result = await client.query('UPDATE spotlight_students SET avatar_group=$2 WHERE roll_number=$1', [roll, group]);
      if (result.rowCount) { summary.updated++; summary.counts[group]++; }
      else summary.unknownRollNumbers.push(roll);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  log(`Updated: ${summary.updated}`);
  log(`Unknown roll numbers: ${summary.unknownRollNumbers.length}${summary.unknownRollNumbers.length ? ` (${summary.unknownRollNumbers.join(', ')})` : ''}`);
  log(`Counts per group: male=${summary.counts.male}, female=${summary.counts.female}, neutral=${summary.counts.neutral}`);
  return summary;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--file')) {
    console.error('Usage: node scripts/import-genders.js [--file data/genders.xlsx]');
    process.exitCode = 1;
    pool.end();
  } else {
    importGenders(args.length ? { file: path.resolve(args[1]) } : {})
      .catch(error => { console.error('Avatar-group import failed:', error.code || error.message); process.exitCode = 1; })
      .finally(() => pool.end());
  }
}
module.exports = { importGenders };
