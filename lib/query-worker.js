'use strict';
// Runs one read-only query in its own thread so a runaway query can be killed.
const { parentPort, workerData } = require('node:worker_threads');
const { openQueryConnection } = require('./connect');

const { dbPath, sql, maxRows, validateOnly } = workerData;
try {
  const { db } = openQueryConnection(dbPath);
  const started = process.hrtime.bigint();
  const stmt = db.prepare(sql); // throws on unknown tables/columns or syntax errors
  const columns = stmt.columns().map((c) => ({ name: c.name, table: c.table || null, column: c.column || null }));
  if (validateOnly) {
    parentPort.postMessage({ ok: true, columns });
  } else {
    stmt.setReturnArrays?.(true); // keeps duplicate column names apart when supported
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const vals = Array.isArray(row) ? row : columns.map((c) => row[c.name]);
      rows.push(vals.map((v) => (typeof v === 'bigint' ? Number(v) : v)));
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    parentPort.postMessage({ ok: true, columns, rows, truncated, ms: Math.round(ms * 10) / 10 });
  }
  db.close();
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e.message || e) });
}
