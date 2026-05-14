/**
 * Sinnvoll Lead CRM – Railway API Server
 * =======================================
 * Express + PostgreSQL Backend für das CRM.
 * Frontend läuft auf GitHub Pages, dieser Server läuft auf Railway.
 *
 * Lokaler Start (ohne Datenbank, nur für Tests):
 *   DATABASE_URL=... node server.js
 */

const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS: GitHub Pages + lokale Entwicklung ──────────────────────────────────
app.use(cors({
  origin: [
    'https://nocturner1.github.io',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
  ],
  methods:      ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials:  false,
}));
app.use(express.json({ limit: '20mb' }));

// ── PostgreSQL ────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL ist nicht gesetzt.');
  console.error('   Auf Railway: PostgreSQL-Plugin hinzufügen → wird automatisch gesetzt.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // Railway braucht SSL
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL Verbindungsfehler:', err.message);
});

// ── Tabellen erstellen (beim ersten Start) ────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_state (
      id          VARCHAR(300) PRIMARY KEY,
      status      VARCHAR(100) NOT NULL DEFAULT 'Neu',
      notiz       TEXT         NOT NULL DEFAULT '',
      kontakt_by  VARCHAR(200) NOT NULL DEFAULT '',
      updated_at  VARCHAR(100) NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS imported_leads (
      id         VARCHAR(300) PRIMARY KEY,
      data       JSONB        NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅  Datenbank-Tabellen bereit');
}

// ── Health-Check ──────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── GET /api/crm ─ ganzen CRM-State laden ────────────────────────────────────
// Gibt zurück: { "leadId": { status, notiz, kontaktBy, updatedAt }, ... }
app.get('/api/crm', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_state');
    const state = {};
    rows.forEach(r => {
      state[r.id] = {
        status:    r.status,
        notiz:     r.notiz,
        kontaktBy: r.kontakt_by,
        updatedAt: r.updated_at,
      };
    });
    res.json(state);
  } catch (err) {
    console.error('GET /api/crm:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/crm/:id ─ einzelnen Lead speichern (effizient, pro Änderung) ───
// Body: { status, notiz, kontaktBy, updatedAt }
app.post('/api/crm/:id', async (req, res) => {
  const { id } = req.params;
  const v = req.body || {};
  try {
    await pool.query(`
      INSERT INTO crm_state (id, status, notiz, kontakt_by, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        status     = EXCLUDED.status,
        notiz      = EXCLUDED.notiz,
        kontakt_by = EXCLUDED.kontakt_by,
        updated_at = EXCLUDED.updated_at
    `, [id, v.status || 'Neu', v.notiz || '', v.kontaktBy || '', v.updatedAt || '']);
    res.json({ ok: true });
  } catch (err) {
    console.error(`POST /api/crm/${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/crm ─ Bulk-Upsert (für Import mit Notizen) ─────────────────────
// Body: { "id": { status, notiz, kontaktBy, updatedAt }, ... }
app.post('/api/crm', async (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'Erwartet: JSON-Objekt {id: {...}}' });
  }
  const entries = Object.entries(state);
  if (entries.length === 0) return res.json({ ok: true, updated: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, v] of entries) {
      await client.query(`
        INSERT INTO crm_state (id, status, notiz, kontakt_by, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          status     = EXCLUDED.status,
          notiz      = EXCLUDED.notiz,
          kontakt_by = EXCLUDED.kontakt_by,
          updated_at = EXCLUDED.updated_at
      `, [id, v.status || 'Neu', v.notiz || '', v.kontaktBy || '', v.updatedAt || '']);
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated: entries.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/crm (bulk):', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/imported ─ importierte Leads laden ───────────────────────────────
// Gibt zurück: Array von Lead-Objekten
app.get('/api/imported', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT data FROM imported_leads ORDER BY created_at ASC'
    );
    res.json(rows.map(r => r.data));
  } catch (err) {
    console.error('GET /api/imported:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/imported ─ importierte Leads speichern (Bulk-Upsert) ────────────
// Body: Array von Lead-Objekten (jedes braucht ein "id"-Feld)
app.post('/api/imported', async (req, res) => {
  const leads = req.body;
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: 'Erwartet: JSON-Array von Leads' });
  }
  if (leads.length === 0) return res.json({ ok: true, count: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const lead of leads) {
      if (!lead.id) continue;
      await client.query(`
        INSERT INTO imported_leads (id, data)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `, [lead.id, JSON.stringify(lead)]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: leads.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/imported:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/imported/:id ─ einzelnen importierten Lead entfernen ──────────
app.delete('/api/imported/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM imported_leads WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats ─ Schnell-Übersicht ───────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const [crm, imp] = await Promise.all([
      pool.query('SELECT status, COUNT(*)::int AS n FROM crm_state GROUP BY status'),
      pool.query('SELECT COUNT(*)::int AS n FROM imported_leads'),
    ]);
    const byStatus = {};
    crm.rows.forEach(r => { byStatus[r.status] = r.n; });
    res.json({ byStatus, importedLeads: imp.rows[0].n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀  Sinnvoll CRM API läuft auf Port ${PORT}`);
      console.log(`   Health:   http://localhost:${PORT}/api/health`);
      console.log(`   CRM:      http://localhost:${PORT}/api/crm`);
      console.log(`   Imports:  http://localhost:${PORT}/api/imported\n`);
    });
  })
  .catch(err => {
    console.error('❌  Datenbankinitialisierung fehlgeschlagen:', err.message);
    process.exit(1);
  });
