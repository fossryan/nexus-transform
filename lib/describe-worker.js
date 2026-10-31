'use strict';
// Builds the schema description (tables, row counts, data ranges) off the main thread.
const { parentPort, workerData } = require('node:worker_threads');
const { buildDescription } = require('./finance');

try {
  parentPort.postMessage({ ok: true, description: buildDescription(workerData.dbPath) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e.message || e) });
}
