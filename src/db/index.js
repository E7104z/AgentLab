const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function createDb(connectionString, { schema } = {}) {
  const pool = new Pool({
    connectionString,
    max: 10,
    ssl: /sslmode=require/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined,
    options: schema ? `-c search_path="${schema}"` : undefined,
  });

  const db = {
    pool,
    query: (text, params) => pool.query(text, params),
    async one(text, params) {
      const r = await pool.query(text, params);
      return r.rows[0] || null;
    },
    async many(text, params) {
      const r = await pool.query(text, params);
      return r.rows;
    },
    /** Runs fn inside a transaction with a dedicated client. */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (t, p) => client.query(t, p),
          one: async (t, p) => (await client.query(t, p)).rows[0] || null,
          many: async (t, p) => (await client.query(t, p)).rows,
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    /** Session-level advisory lock so two instances never run the same job at once. */
    async withLock(name, fn) {
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
        if (!rows[0].ok) return { skipped: true };
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
        }
      } finally {
        client.release();
      }
    },
    async migrate() {
      if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      const applied = [];
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await db.tx(async (t) => {
          await t.query(sql);
          await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        });
        applied.push(file);
      }
      return applied;
    },
    async getState(key, fallback = null) {
      const row = await db.one('SELECT value FROM agent_state WHERE key = $1', [key]);
      return row ? row.value : fallback;
    },
    async setState(key, value) {
      await db.query(
        `INSERT INTO agent_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },
    async audit(actor, action, details = {}, clientId = null) {
      await db.query('INSERT INTO audit_log (client_id, actor, action, details) VALUES ($1, $2, $3, $4)', [
        clientId,
        actor,
        action,
        JSON.stringify(details),
      ]);
    },
    close: () => pool.end(),
  };
  return db;
}

module.exports = { createDb };
