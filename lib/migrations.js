const pool = require('../db');
async function runMigration(name, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize migration runners across boards and processes, including table creation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mytkr-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const existing = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [name]);
    if (!existing.rows.length) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
module.exports = { runMigration };
