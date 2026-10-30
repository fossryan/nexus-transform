'use strict';
// Disk-space safety for the /data volume. A full volume used to crash the app at startup
// (SQLite can't create its -shm file), so:
//   - cleanLeftovers()  removes temp files that interrupted jobs leave behind
//   - a small reserve file is kept so space can be freed to open the app's own databases
//   - hasRoom()         lets big background jobs skip a run instead of filling the disk
const fs = require('node:fs');
const path = require('node:path');

const MB = 1024 * 1024;
const RESERVE_FILE = '.space-reserve';

function diskStatus(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalMb: Math.round(total / MB), freeMb: Math.round(free / MB), usedPct: total ? Math.round((1 - free / total) * 100) : null };
  } catch { return null; }
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } // unknown: don't block
}

const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

// Room for `needBytes` plus a safety margin that always stays free.
function hasRoom(dir, needBytes, marginBytes) {
  const free = freeBytes(dir);
  return { ok: free >= needBytes + marginBytes, freeMb: Math.round(free / MB), needMb: Math.round((needBytes + marginBytes) / MB) };
}

// Temp files from jobs that were interrupted (crash, restart, full disk). None of them are
// needed after a restart: each job rebuilds or re-downloads from scratch.
function cleanLeftovers(dataDir, log = () => {}) {
  let freed = 0;
  const rm = (file) => { const n = sizeOf(file); try { fs.rmSync(file, { force: true, recursive: true }); freed += n; } catch {} };
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (/\.building(-wal|-shm)?$/.test(name) || name.endsWith('.part')) rm(path.join(dataDir, name));
    }
  } catch {}
  const downloads = path.join(dataDir, 'downloads');
  try { for (const name of fs.readdirSync(downloads)) rm(path.join(downloads, name)); } catch {}
  if (freed > 0) log(`· Removed ${Math.round(freed / MB)} MB of leftover temp files`);
  return freed;
}

// A placeholder file that holds back a little space for emergencies.
function ensureReserve(dataDir, bytes) {
  const file = path.join(dataDir, RESERVE_FILE);
  if (sizeOf(file) >= bytes) return true;
  if (freeBytes(dataDir) < bytes * 3) return false; // don't eat the last free space to make it
  try {
    const fd = fs.openSync(file, 'w');
    try { fs.writeSync(fd, Buffer.alloc(bytes)); } finally { fs.closeSync(fd); }
    return true;
  } catch { try { fs.rmSync(file, { force: true }); } catch {} return false; }
}

function releaseReserve(dataDir) {
  const file = path.join(dataDir, RESERVE_FILE);
  const n = sizeOf(file);
  try { fs.rmSync(file, { force: true }); } catch {}
  return n;
}

// SQLite reports a full disk as SQLITE_FULL or as an I/O error (e.g. when it can't grow the
// -shm file); Node reports ENOSPC.
function isDiskError(e) {
  const s = `${e && e.code} ${e && e.errstr} ${e && e.message}`;
  return /ENOSPC|SQLITE_FULL|disk is full|disk I\/O error/i.test(s);
}

// Open something the app can't run without. On a full disk: free space and retry; if it
// still fails, use `fallback` (e.g. an in-memory database) so the site stays up. Never
// deletes real data.
function openWithRecovery(open, { dataDir, log = () => {}, fallback } = {}) {
  try { return { value: open(), degraded: false }; } catch (e) {
    if (!isDiskError(e)) throw e;
    const freed = releaseReserve(dataDir) + cleanLeftovers(dataDir, log);
    log(`! Disk full while starting up (${e.message}); freed ${Math.round(freed / MB)} MB and retrying.`);
    try { return { value: open(), degraded: false }; } catch (e2) {
      if (!isDiskError(e2) || !fallback) throw e2;
      log('! Still no space. Running with temporary storage: work saved now is lost on restart. Add space with: fly volumes extend');
      return { value: fallback(), degraded: true };
    }
  }
}

module.exports = { MB, diskStatus, freeBytes, sizeOf, hasRoom, cleanLeftovers, ensureReserve, releaseReserve, isDiskError, openWithRecovery };
