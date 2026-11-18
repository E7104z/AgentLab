/** Data helpers. Every function takes clientId explicitly so no query can cross clients. */
const { refCode } = require('./lib/util');

function createStore(db) {
  const store = {
    async upsertContact(clientId, fields) {
      const email = fields.email ? String(fields.email).trim().toLowerCase() : null;
      if (email) {
        const existing = await db.one('SELECT * FROM contacts WHERE client_id = $1 AND lower(email) = $2', [clientId, email]);
        if (existing) {
          const merged = {
            name: fields.name || existing.name,
            business: fields.business || existing.business,
            phone: fields.phone || existing.phone,
            chore: fields.chore || existing.chore,
            ref: existing.ref || fields.ref || null,
            source: existing.source || fields.source || null,
            landing_page: existing.landing_page || fields.landing_page || null,
          };
          return db.one(
            `UPDATE contacts SET name=$2, business=$3, phone=$4, chore=$5, ref=$6, source=$7, landing_page=$8, updated_at=now()
             WHERE id=$1 RETURNING *`,
            [existing.id, merged.name, merged.business, merged.phone, merged.chore, merged.ref, merged.source, merged.landing_page]
          );
        }
      }
      const row = await db.one(
        `INSERT INTO contacts (client_id, email, name, business, phone, source, ref, utm, landing_page, chore)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          clientId,
          email,
          fields.name || null,
          fields.business || null,
          fields.phone || null,
          fields.source || null,
          fields.ref || null,
          JSON.stringify(fields.utm || {}),
          fields.landing_page || null,
          fields.chore || null,
        ]
      );
      return db.one('UPDATE contacts SET ref_code=$2 WHERE id=$1 RETURNING *', [row.id, refCode(clientId, row.id)]);
    },

    getContact: (clientId, id) => db.one('SELECT * FROM contacts WHERE client_id=$1 AND id=$2', [clientId, id]),
    findContactByEmail: (clientId, email) =>
      db.one('SELECT * FROM contacts WHERE client_id=$1 AND lower(email)=lower($2)', [clientId, email || '']),
    setContactStatus: (clientId, id, status) =>
      db.query('UPDATE contacts SET status=$3, updated_at=now() WHERE client_id=$1 AND id=$2', [clientId, id, status]),

    async upsertConversation(clientId, { contactId, mailbox, threadId, subject }) {
      return db.one(
        `INSERT INTO conversations (client_id, contact_id, mailbox, thread_id, subject)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (mailbox, thread_id) DO UPDATE SET last_message_at = now(),
           contact_id = COALESCE(conversations.contact_id, EXCLUDED.contact_id)
         RETURNING *`,
        [clientId, contactId, mailbox, threadId, subject || null]
      );
    },
    latestConversation: (clientId, contactId) =>
      db.one('SELECT * FROM conversations WHERE client_id=$1 AND contact_id=$2 ORDER BY last_message_at DESC LIMIT 1', [clientId, contactId]),

    /** Last message in a conversation, used to thread follow-ups (In-Reply-To / References). */
    lastThreadMessage: (conversationId) =>
      db.one('SELECT * FROM messages WHERE conversation_id=$1 AND rfc_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [conversationId]),

    threadHistory: (conversationId, limit = 6) =>
      db
        .many('SELECT direction, body, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2', [conversationId, limit])
        .then((rows) => rows.reverse()),

    async addEvent(clientId, { contactId = null, type, externalId = null, payload = {} }) {
      const r = await db.query(
        `INSERT INTO events (client_id, contact_id, type, external_id, payload) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (type, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
        [clientId, contactId, type, externalId, JSON.stringify(payload)]
      );
      return r.rows[0] || null; // null = duplicate (already processed)
    },

    async addTask(clientId, { contactId = null, dealId = null, kind, title, details = '', dueAt = null, dedupeKey = null }) {
      const r = await db.query(
        `INSERT INTO tasks (client_id, contact_id, deal_id, kind, title, details, due_at, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
        [clientId, contactId, dealId, kind, title, details, dueAt, dedupeKey]
      );
      return r.rows[0] || null;
    },

    async suppress(clientId, email, reason) {
      if (!email) return;
      await db.query(
        `INSERT INTO suppressions (client_id, email, reason) VALUES ($1, lower($2), $3) ON CONFLICT DO NOTHING`,
        [clientId, email, reason]
      );
      await db.query('UPDATE contacts SET do_not_email=TRUE, updated_at=now() WHERE client_id=$1 AND lower(email)=lower($2)', [clientId, email]);
    },
    async isSuppressed(clientId, email) {
      const r = await db.one('SELECT 1 AS x FROM suppressions WHERE client_id=$1 AND email=lower($2)', [clientId, email || '']);
      return Boolean(r);
    },

    async stopEnrollments(clientId, contactId, reason, sequenceKeys = null) {
      const r = await db.query(
        `UPDATE enrollments SET status='stopped', stop_reason=$3, updated_at=now()
         WHERE client_id=$1 AND contact_id=$2 AND status='active' AND ($4::text[] IS NULL OR sequence_key = ANY($4))`,
        [clientId, contactId, reason, sequenceKeys]
      );
      return r.rowCount;
    },

    getDeal: (clientId, id) => db.one('SELECT * FROM deals WHERE client_id=$1 AND id=$2', [clientId, id]),
    openDealForContact: (clientId, contactId) =>
      db.one(
        `SELECT * FROM deals WHERE client_id=$1 AND contact_id=$2 AND stage NOT IN ('lost') ORDER BY created_at DESC LIMIT 1`,
        [clientId, contactId]
      ),
    async updateDeal(clientId, id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return store.getDeal(clientId, id);
      const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
      return db.one(`UPDATE deals SET ${sets}, updated_at=now() WHERE client_id=$1 AND id=$2 RETURNING *`, [
        clientId,
        id,
        ...keys.map((k) => fields[k]),
      ]);
    },
  };
  return store;
}

module.exports = { createStore };
