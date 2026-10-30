'use strict';
// Small fetch helpers with retries, used by every data loader.
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never let API keys passed as query parameters end up in logs or error messages.
const redact = (url) => String(url).replace(/(token|api_key|apikey)=[^&]+/gi, '$1=***');

async function withRetry(fn, { tries = 3, label = '' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e; // client errors won't fix themselves
      await sleep(e.status === 429 ? 5000 * (i + 1) : 1000 * (i + 1));
    }
  }
  throw Object.assign(new Error(`${label} ${last.message}`.trim()), { status: last.status });
}

async function getJson(url, headers = {}) {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
    if (res.status === 404) return null; // EDGAR returns 404 for frames/records that don't exist
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} — ${redact(url)}`), { status: res.status });
    return res.json();
  });
}

async function getText(url, headers = {}) {
  return withRetry(async () => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} — ${redact(url)}`), { status: res.status });
    return res.text();
  });
}

// Stream a (possibly large) file to disk without holding it in memory.
async function download(url, dest, headers = {}) {
  return withRetry(async () => {
    const res = await fetch(url, { headers });
    if (res.status === 404) return false;
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} — ${redact(url)}`), { status: res.status });
    const tmp = `${dest}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {} // don't leave a half-written file taking up space
      throw e;
    }
    fs.renameSync(tmp, dest);
    return true;
  });
}

module.exports = { getJson, getText, download, sleep, withRetry, redact };
