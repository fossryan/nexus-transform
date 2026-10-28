'use strict';
// App state: transformations, their versions, and the audit log. Scoped per browser session.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS transformations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_review',      -- in_review | accepted | rejected
      accepted_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      transformation_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      author TEXT NOT NULL,                          -- 'ai' | 'user'
      actor TEXT NOT NULL,                           -- display name, or model id for ai
      prompt TEXT,
      sql TEXT NOT NULL,
      summary TEXT,
      confidence INTEGER,
      confidence_reason TEXT,
      assumptions TEXT NOT NULL DEFAULT '[]',
      clarifying_question TEXT,
      checks TEXT NOT NULL DEFAULT '[]',
      row_count INTEGER,
      truncated INTEGER,
      run_ms REAL,
      decision TEXT,                                 -- null | accepted | rejected | superseded
      decision_note TEXT,
      parent_version_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL,                      -- ai | user | system
      event TEXT NOT NULL,                           -- generated | repaired | edited | accepted | rejected | run_failed | blocked
      transformation_id TEXT,
      version_id TEXT,
      detail TEXT,
      status TEXT NOT NULL                           -- ai_action | verified | modified | rejected | error | info
    );
    CREATE INDEX IF NOT EXISTS audit_session ON audit(session_id, id);
    CREATE INDEX IF NOT EXISTS tx_session ON transformations(session_id, updated_at);
    CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, generations INTEGER NOT NULL DEFAULT 0);
  `);

  const now = () => new Date().toISOString();
  const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
  const parseV = (v) => v && ({
    ...v,
    assumptions: JSON.parse(v.assumptions || '[]'),
    checks: JSON.parse(v.checks || '[]'),
    truncated: !!v.truncated,
  });

  function audit(sessionId, e) {
    db.prepare('INSERT INTO audit (session_id, at, actor, actor_type, event, transformation_id, version_id, detail, status) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(sessionId, now(), e.actor, e.actorType, e.event, e.transformationId || null, e.versionId || null, e.detail || null, e.status);
  }

  function createTransformation(sessionId, { title, prompt }) {
    const t = { id: id('tx'), session_id: sessionId, title, prompt, status: 'in_review', created_at: now(), updated_at: now() };
    db.prepare('INSERT INTO transformations (id, session_id, title, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(t.id, t.session_id, t.title, t.prompt, t.status, t.created_at, t.updated_at);
    return t;
  }

  function getTransformation(sessionId, txId) {
    const t = db.prepare('SELECT * FROM transformations WHERE id = ? AND session_id = ?').get(txId, sessionId);
    if (!t) return null;
    const versions = db.prepare('SELECT * FROM versions WHERE transformation_id = ? ORDER BY number').all(txId).map(parseV);
    return { ...t, versions };
  }

  function listTransformations(sessionId) {
    return db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM versions v WHERE v.transformation_id = t.id) AS version_count,
             (SELECT confidence FROM versions v WHERE v.transformation_id = t.id ORDER BY number DESC LIMIT 1) AS latest_confidence
      FROM transformations t WHERE session_id = ? ORDER BY updated_at DESC LIMIT 100`).all(sessionId)
      .map((t) => ({ ...t, version_count: Number(t.version_count) }));
  }

  function addVersion(txId, v) {
    const number = Number(db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE transformation_id = ?').get(txId).n);
    const row = {
      id: id('v'), transformation_id: txId, number, author: v.author, actor: v.actor, prompt: v.prompt || null, sql: v.sql,
      summary: v.summary || null, confidence: v.confidence ?? null, confidence_reason: v.confidenceReason || null,
      assumptions: JSON.stringify(v.assumptions || []), clarifying_question: v.clarifyingQuestion || null,
      checks: JSON.stringify(v.checks || []), row_count: v.rowCount ?? null, truncated: v.truncated ? 1 : 0, run_ms: v.runMs ?? null,
      decision: null, decision_note: null, parent_version_id: v.parentVersionId || null, created_at: now(),
    };
    db.prepare(`INSERT INTO versions VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    // Any earlier undecided version is superseded by the new one.
    db.prepare("UPDATE versions SET decision = 'superseded' WHERE transformation_id = ? AND id != ? AND decision IS NULL").run(txId, row.id);
    db.prepare("UPDATE transformations SET updated_at = ?, status = 'in_review', title = COALESCE(?, title) WHERE id = ?").run(now(), v.title || null, txId);
    return parseV(row);
  }

  function getVersion(sessionId, versionId) {
    const v = db.prepare('SELECT v.* FROM versions v JOIN transformations t ON t.id = v.transformation_id WHERE v.id = ? AND t.session_id = ?').get(versionId, sessionId);
    return parseV(v);
  }

  function decide(sessionId, versionId, decision, note) {
    const v = getVersion(sessionId, versionId);
    if (!v) return null;
    db.prepare('UPDATE versions SET decision = ?, decision_note = ? WHERE id = ?').run(decision, note || null, versionId);
    if (decision === 'accepted') {
      db.prepare("UPDATE transformations SET status = 'accepted', accepted_version_id = ?, updated_at = ? WHERE id = ?").run(versionId, now(), v.transformation_id);
    } else {
      db.prepare("UPDATE transformations SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), v.transformation_id);
    }
    return getVersion(sessionId, versionId);
  }

  function listAudit(sessionId, limit = 300) {
    return db.prepare(`
      SELECT a.*, t.title AS transformation_title, v.number AS version_number
      FROM audit a
      LEFT JOIN transformations t ON t.id = a.transformation_id
      LEFT JOIN versions v ON v.id = a.version_id
      WHERE a.session_id = ? ORDER BY a.id DESC LIMIT ?`).all(sessionId, limit);
  }

  function bumpDailyUsage() {
    const day = now().slice(0, 10);
    db.prepare('INSERT INTO usage_daily (day, generations) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET generations = generations + 1').run(day);
    return Number(db.prepare('SELECT generations FROM usage_daily WHERE day = ?').get(day).generations);
  }
  function dailyUsage() {
    const r = db.prepare('SELECT generations FROM usage_daily WHERE day = ?').get(now().slice(0, 10));
    return r ? Number(r.generations) : 0;
  }

  return { audit, createTransformation, getTransformation, listTransformations, addVersion, getVersion, decide, listAudit, bumpDailyUsage, dailyUsage };
}

module.exports = { createStore };
