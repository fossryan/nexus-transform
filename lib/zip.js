'use strict';
// Minimal streaming ZIP reader: lists entries and streams one entry's lines without
// unpacking the archive into memory (SEC's 13F sets are ~100 MB zipped, much more unzipped).
const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  return buf;
}

function listEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) { // ZIP64
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64Off = Number(tail.readBigUInt64LE(loc + 8));
        const z = readAt(fd, z64Off, 56);
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOffset = Number(z.readBigUInt64LE(48));
      }
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p < cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size2 = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // ZIP64 extra field holds the real sizes/offset when the 32-bit ones are maxed out.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e); const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size2 === 0xffffffff) { size2 = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compSize, size: size2, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally { fs.closeSync(fd); }
}

// Async iterator over the text lines of one entry (matched case-insensitively by basename).
async function* entryLines(file, basename) {
  const entry = listEntries(file).find((e) => e.name.split('/').pop().toLowerCase() === basename.toLowerCase());
  if (!entry) return;
  const fd = fs.openSync(file, 'r');
  const lh = readAt(fd, entry.localOffset, 30);
  fs.closeSync(fd);
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  let stream = fs.createReadStream(file, { start: dataStart, end: dataStart + entry.compSize - 1 });
  if (entry.method === 8) stream = stream.pipe(zlib.createInflateRaw());
  else if (entry.method !== 0) throw new Error(`Unsupported zip compression method ${entry.method}`);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

// Iterate a tab-delimited entry as objects keyed by the header row.
async function* entryRows(file, basename) {
  let header = null;
  for await (const line of entryLines(file, basename)) {
    if (!header) { header = line.replace(/^﻿/, '').split('\t').map((h) => h.trim().toUpperCase()); continue; }
    if (!line) continue;
    const cols = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] === undefined || cols[i] === '' ? null : cols[i];
    yield row;
  }
}

module.exports = { listEntries, entryLines, entryRows };
