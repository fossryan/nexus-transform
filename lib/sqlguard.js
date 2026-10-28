'use strict';
// First line of defence for model- or user-written SQL. The second line is that the
// finance database is opened read-only in a worker thread with a hard timeout.

const BLOCKED = /\b(attach|detach|pragma|insert|update|delete|drop|alter|create|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension|readfile|writefile)\b/i;

// Remove string literals, quoted identifiers and comments so keyword checks
// only see SQL structure (a company named "Delete Corp" must not trip the guard).
function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) { if (sql[i + 1] === close && close !== ']') { i += 2; continue; } break; }
        i++;
      }
      i++;
      out += c === "'" ? "''" : 'x';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { ok: false, reason: 'SQL is empty.' };
  if (sql.length > 8000) return { ok: false, reason: 'SQL is longer than 8,000 characters.' };
  const bare = stripLiteralsAndComments(sql).trim().replace(/;\s*$/, '');
  if (bare.includes(';')) return { ok: false, reason: 'Only one statement is allowed.' };
  if (!/^(select|with)\b/i.test(bare)) return { ok: false, reason: 'Only SELECT queries (optionally starting with WITH) can run here.' };
  const m = bare.match(BLOCKED);
  if (m) return { ok: false, reason: `"${m[1].toUpperCase()}" is not allowed — transformations are read-only.` };
  return { ok: true, sql: sql.trim().replace(/;\s*$/, '') };
}

module.exports = { checkSql, stripLiteralsAndComments };
