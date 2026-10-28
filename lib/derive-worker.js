'use strict';
// Runs lib/derive.js off the main thread so the web server stays responsive while
// derived tables rebuild.
const { parentPort, workerData } = require('node:worker_threads');
const { materialize } = require('./derive');

const logs = [];
try {
  materialize({ ...workerData, log: (l) => logs.push(l) });
  parentPort.postMessage({ ok: true, logs });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e.message || e), logs });
}
