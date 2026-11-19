const pool = require('../db');

async function initSpotlightSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spotlight_students (
      roll_number TEXT PRIMARY KEY, name TEXT NOT NULL, course TEXT NOT NULL,
      section TEXT, year TEXT NOT NULL, photo_data BYTEA,
      hidden BOOLEAN NOT NULL DEFAULT FALSE, like_count INTEGER NOT NULL DEFAULT 0,
      note_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS photo_data BYTEA;
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS note_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE spotlight_students ADD COLUMN IF NOT EXISTS avatar_group TEXT NOT NULL DEFAULT 'neutral'
      CHECK (avatar_group IN ('male','female','neutral'));
    CREATE INDEX IF NOT EXISTS spotlight_students_filters ON spotlight_students(year, course, section);
    CREATE INDEX IF NOT EXISTS spotlight_students_name ON spotlight_students(name);
    CREATE INDEX IF NOT EXISTS spotlight_students_likes ON spotlight_students(like_count DESC);
    CREATE INDEX IF NOT EXISTS spotlight_students_notes ON spotlight_students(note_count DESC);
    CREATE TABLE IF NOT EXISTS spotlight_likes (
      roll_number TEXT REFERENCES spotlight_students ON DELETE CASCADE,
      voter_hash VARCHAR(64) NOT NULL, ip_hash VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(roll_number, voter_hash)
    );
    CREATE INDEX IF NOT EXISTS spotlight_likes_created ON spotlight_likes(created_at);
    CREATE INDEX IF NOT EXISTS spotlight_likes_ip ON spotlight_likes(roll_number, ip_hash);
    ALTER TABLE spotlight_likes ADD COLUMN IF NOT EXISTS device_hash VARCHAR(64);
    CREATE INDEX IF NOT EXISTS spotlight_likes_device ON spotlight_likes(roll_number, device_hash);
    CREATE TABLE IF NOT EXISTS spotlight_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS spotlight_notes (
      id SERIAL PRIMARY KEY, roll_number TEXT REFERENCES spotlight_students ON DELETE CASCADE,
      text VARCHAR(200) NOT NULL, ip_hash VARCHAR(64) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),
      reported BOOLEAN NOT NULL DEFAULT FALSE,
      react_heart INT NOT NULL DEFAULT 0, react_laugh INT NOT NULL DEFAULT 0,
      react_fire INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS spotlight_notes_student ON spotlight_notes(roll_number, status);
    CREATE INDEX IF NOT EXISTS spotlight_notes_approved ON spotlight_notes(approved_at);
    CREATE INDEX IF NOT EXISTS spotlight_notes_feed ON spotlight_notes(status, approved_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS spotlight_notes_ip ON spotlight_notes(ip_hash, status);
    ALTER TABLE spotlight_notes ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS spotlight_note_reports (
      note_id INT REFERENCES spotlight_notes ON DELETE CASCADE,
      voter_hash VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(note_id, voter_hash)
    );
    CREATE TABLE IF NOT EXISTS spotlight_note_reactions (
      note_id INT REFERENCES spotlight_notes ON DELETE CASCADE,
      voter_hash VARCHAR(64), emoji VARCHAR(10), PRIMARY KEY(note_id, voter_hash)
    );
  `);
}

module.exports = { initSpotlightSchema };
