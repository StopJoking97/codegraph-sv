/**
 * Precision sampling for `reads` edges — independent of the extractor.
 *
 * METHOD (recorded so the figure is reproducible):
 *   1. Population: every recorded read SITE, not every edge. A `reads` edge is
 *      aggregated per (reader, net) and carries N line numbers, so sampling
 *      edges alone would leave most claims unexamined. Sites are enumerated in
 *      edge-id order, then line order within an edge.
 *   2. Sample: a fixed-stride systematic sample — every Nth site. Systematic
 *      rather than random so it is reproducible with no seed, and so it spreads
 *      across every file instead of clustering in one large module.
 *   3. Oracle: the SOURCE TEXT, re-read with regexes only. tree-sitter is never
 *      consulted, so a grammar-level mistake cannot vote for itself. For each
 *      sampled site the claim "module M reads net X at line L" is checked as:
 *        a. X occurs on line L (as a whole word, comments stripped), AND
 *        b. that occurrence is in READ position, decided textually: the
 *           statement's assignment operator (`=`, `<=`) is located and the
 *           occurrence must be on its RIGHT, or inside a bracketed index on its
 *           left (`mem[X] <= d` reads X), or the statement has no assignment
 *           operator at all (a sensitivity list, a condition, a call argument).
 *   4. Verdict: precision = PASS / (PASS + FAIL). UNCHECKED rows are listed so
 *      they can be read by hand rather than silently absorbed.
 *
 * Usage: node scripts/sv/reads-precision.cjs [dbPath] [corpusRoot] [target]
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB = process.argv[2] || '.codegraph/codegraph.db';
const ROOT = process.argv[3] || '.';
const TARGET = Number(process.argv[4] || 200);

const db = new DatabaseSync(DB, { readOnly: true });

const edges = db
  .prepare(
    `SELECT e.id, e.metadata,
            s.name AS reader, s.file_path AS readerFile,
            t.name AS net
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE e.kind = 'reads'
     ORDER BY e.id`
  )
  .all();

const sites = [];
for (const e of edges) {
  let m = {};
  try { m = JSON.parse(e.metadata || '{}'); } catch {}
  for (const line of m.lines || []) sites.push({ ...e, line });
}

const stride = Math.max(1, Math.floor(sites.length / TARGET));
const sample = sites.filter((_, i) => i % stride === 0);

const fileCache = new Map();
function lines(rel) {
  if (!fileCache.has(rel)) {
    try {
      fileCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/));
    } catch {
      fileCache.set(rel, null);
    }
  }
  return fileCache.get(rel);
}

/** Strip comments so a commented-out mention cannot satisfy a claim. */
function decomment(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const results = { PASS: 0, FAIL: 0, UNCHECKED: 0 };
const notes = [];

for (const s of sample) {
  const src = lines(s.readerFile);
  const label = `${s.readerFile}:${s.line} ${s.reader} reads ${s.net}`;
  if (!src || !src[s.line - 1]) { results.UNCHECKED++; notes.push(`UNCHECKED (no source) ${label}`); continue; }
  const text = decomment(src[s.line - 1]);
  const word = new RegExp(`\\b${s.net.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  // EVERY occurrence, not just the first: `cnt = cnt + 1;` mentions the net on
  // both sides, and testing only the leftmost would report the write and miss
  // the read that is genuinely there.
  const occurrences = [];
  for (let i = text.search(word); i >= 0; ) {
    occurrences.push(i);
    const rest = text.slice(i + 1).search(word);
    i = rest < 0 ? -1 : i + 1 + rest;
  }
  if (occurrences.length === 0) { results.FAIL++; notes.push(`FAIL (not on line) ${label}  «${text.trim().slice(0, 70)}»`); continue; }

  // Assignment operator, if this line carries one. `<=` is ambiguous with the
  // comparison operator; a comparison has an operand on both sides and no
  // statement terminator implication, so treat `<=` as an assignment only when
  // the text before it is a bare lvalue (identifier with optional index).
  const nb = text.indexOf('<=');
  const bl = text.search(/(?<![<>=!+\-*/%&|^])=(?![=<>])/);
  let opAt = -1;
  if (nb >= 0 && /^\s*[A-Za-z_]\w*(\s*\[[^\]]*\])?\s*$/.test(text.slice(0, nb))) opAt = nb;
  else if (bl >= 0) opAt = bl;

  if (opAt < 0) { results.PASS++; continue; } // sensitivity list / condition / argument
  // An occurrence is a read if it sits to the RIGHT of the operator, or inside a
  // bracketed index on its left (`mem[X] <= d` reads X).
  const lhs = text.slice(0, opAt);
  const brackets = [...lhs.matchAll(/\[[^\]]*\]/g)];
  const isRead = (at) =>
    at > opAt || brackets.some((b) => b.index <= at && at < b.index + b[0].length);
  if (occurrences.some(isRead)) { results.PASS++; continue; }
  results.FAIL++;
  notes.push(`FAIL (left of assignment, not an index) ${label}  «${text.trim().slice(0, 70)}»`);
}

const checked = results.PASS + results.FAIL;
console.log(`population: ${edges.length} reads edges / ${sites.length} recorded read sites`);
console.log(`sample:     every ${stride}th site -> ${sample.length} sites`);
console.log(`PASS ${results.PASS} · FAIL ${results.FAIL} · UNCHECKED ${results.UNCHECKED}`);
console.log(`precision:  ${checked ? ((results.PASS / checked) * 100).toFixed(1) : 'n/a'}%  (PASS / (PASS+FAIL))`);
if (notes.length) {
  console.log('\n-- non-PASS rows --');
  for (const n of notes.slice(0, 40)) console.log('  ' + n);
  if (notes.length > 40) console.log(`  ... +${notes.length - 40} more`);
}
