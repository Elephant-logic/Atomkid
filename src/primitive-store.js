'use strict';

// Persistence for synthesized primitives, as a plain JSON file. Deliberately avoids the
// Python/SQLite path so it works on any Node host (including Render's Node runtime). A
// synthesized primitive is saved as a "candidate"; once it has been used successfully enough
// it is promoted to "trusted" and loaded into the registry at startup.
//
// Note on durability: on ephemeral filesystems (e.g. Render's free tier) this file resets on
// redeploy. That's fine for in-instance reuse; for cross-deploy durability, point
// PRIMITIVE_STORE at a mounted disk or swap this module for a database — the interface below
// is the only thing callers depend on.

const fs = require('node:fs');
const path = require('node:path');

const STORE_PATH = process.env.PRIMITIVE_STORE || path.join(__dirname, '..', 'data', 'primitives.json');
const PROMOTE_AT = Number(process.env.PRIMITIVE_PROMOTE_AT || 2);

function readAll() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeAll(data) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

// All trusted definitions, for seeding the registry at startup.
function loadTrusted() {
  const data = readAll();
  return Object.values(data).filter(entry => entry && entry.def && entry.status === 'trusted').map(entry => entry.def);
}

// Save (or update) a definition as a candidate. Idempotent by id.
function saveCandidate(def) {
  const data = readAll();
  const existing = data[def.id];
  data[def.id] = { def, status: existing?.status === 'trusted' ? 'trusted' : 'candidate', uses: existing?.uses || 0 };
  writeAll(data);
  return data[def.id];
}

// Record a successful use; promote candidate -> trusted once it clears PROMOTE_AT.
function recordUse(id) {
  const data = readAll();
  const entry = data[id];
  if (!entry) return null;
  entry.uses = (entry.uses || 0) + 1;
  if (entry.status !== 'trusted' && entry.uses >= PROMOTE_AT) entry.status = 'trusted';
  writeAll(data);
  return entry;
}

module.exports = { loadTrusted, saveCandidate, recordUse, STORE_PATH, PROMOTE_AT, _readAll: readAll };
