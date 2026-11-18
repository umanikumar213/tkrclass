const { Pool } = require('pg');

// Preserve the current Railway TLS default; verified certificates can be opted into.
module.exports = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: process.env.DB_SSL_VERIFY === 'true' }
    : false,
});
