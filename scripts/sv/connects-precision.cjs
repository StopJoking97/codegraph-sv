/**
 * Precision sampling for `connects` edges — independent of the extractor.
 *
 * METHOD (recorded so the figure is reproducible):
 *   1. Population: every `connects` edge in the corpus index, ordered by edge id
 *      (insertion order, which is deterministic for a full re-index).
 *   2. Sample: a fixed-stride systematic sample — every Nth edge, with N chosen
 *      so the sample size is >= the target. Systematic rather than random so the
 *      sample is reproducible with no seed, and it spreads across every file
 *      instead of clustering in one big module the way a head/tail slice would.
 *   3. Oracle: the SOURCE TEXT, re-read with regexes only. tree-sitter is never
 *      consulted, so a grammar-level mistake cannot vote for itself. For each
 *      sampled edge the instantiation statement at the edge's line is sliced out
 *      of the parent file and the claim is checked against it:
 *        named/wildcard  -> `.<port>` must appear in the statement, and the net
 *                           must appear inside that port's own parentheses (or
 *                           the connection must be the implicit `.port` form, or
 *                           the statement must be a `.*` wildcard whose port and
 *                           net names are equal by construction)
 *        positional      -> the net must appear as the Kth comma-separated
 *                           actual, where K is read back from the child module's
 *                           header port order in the child's own file
 *      A claim the oracle cannot reconstruct is reported as UNCHECKED, never as
 *      a pass.
 *   4. Verdict: precision = PASS / (PASS + FAIL). UNCHECKED rows are listed so
 *      they can be read by hand rather than silently absorbed.
 *
 * Usage: node scripts/sv/connects-precision.cjs [dbPath] [corpusRoot] [target]
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
    `SELECT e.id, e.source, e.target, e.line, e.metadata,
            s.name AS sName, s.file_path AS sFile,
            t.name AS tName, t.file_path AS tFile
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE e.kind = 'connects'
     ORDER BY e.id`
  )
  .all();

const stride = Math.max(1, Math.floor(edges.length / TARGET));
const sample = edges.filter((_, i) => i % stride === 0);

const fileCache = new Map();
function readFile(rel) {
  if (!fileCache.has(rel)) {
    try {
      fileCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/));
    } catch {
      fileCache.set(rel, null);
    }
  }
  return fileCache.get(rel);
}

/**
 * The instantiation statement text spanning `line` in `rel` (line is 1-based).
 *
 * Boundaries are found on DECOMMENTED lines: real RTL puts a `;` inside a
 * trailing comment (`.sig_p (sig_p), // pulse;`), and treating
 * that as a statement end slices the instantiation's own header off the front.
 */
function statementAt(rel, line) {
  const lines = readFile(rel);
  if (!lines) return null;
  const bare = lines.map((l) => decomment(l));
  let start = line - 1;
  while (start > 0 && !/;/.test(bare[start - 1] ?? '')) start--;
  let end = line - 1;
  while (end < lines.length - 1 && !/;/.test(bare[end] ?? '')) end++;
  return lines.slice(start, end + 1).join('\n');
}

/** Strip comments so a commented-out port cannot satisfy a claim. */
function decomment(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Balanced-paren slice starting at the `(` at or after `from`. */
function parenSlice(text, from) {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The child module's positional port order, read from its own source header. */
const portOrderCache = new Map();
function portOrder(childFile, childModule) {
  const key = `${childFile}::${childModule}`;
  if (portOrderCache.has(key)) return portOrderCache.get(key);
  const lines = readFile(childFile);
  let order = null;
  if (lines) {
    const src = decomment(lines.join('\n'));
    const re = new RegExp(`\\bmodule\\s+${childModule}\\b`);
    const m = src.match(re);
    if (m && m.index !== undefined) {
      const head = parenSlice(src, m.index);
      if (head !== null) {
        order = head
          .split(',')
          .map((p) => {
            const ids = p.trim().match(/[A-Za-z_]\w*/g);
            return ids && ids.length ? ids[ids.length - 1] : '';
          });
      }
    }
  }
  portOrderCache.set(key, order);
  return order;
}

const results = { PASS: 0, FAIL: 0, UNCHECKED: 0 };
const notes = [];

for (const e of sample) {
  let m = {};
  try { m = JSON.parse(e.metadata || '{}'); } catch {}
  const outward = m.portDirection === 'output';
  // The NET lives in the parent (the file that carries the instantiation line);
  // the PORT lives in the child.
  const net = outward ? e.tName : e.sName;
  const netFile = outward ? e.tFile : e.sFile;
  const portFile = outward ? e.sFile : e.tFile;
  const stmt = statementAt(netFile, e.line);
  const label = `#${e.id} ${netFile}:${e.line} ${net} <-> ${m.instance}.${m.port} (${m.portDirection})`;

  if (!stmt) { results.UNCHECKED++; notes.push(`UNCHECKED (no source) ${label}`); continue; }
  const text = decomment(stmt);

  // The instance name must be present, or we are looking at the wrong statement.
  if (m.instance && !new RegExp(`\\b${m.instance}\\b`).test(text)) {
    results.FAIL++; notes.push(`FAIL (instance absent) ${label}`); continue;
  }

  const wildcard = /\.\s*\*/.test(text);
  const named = new RegExp(`\\.\\s*${m.port}\\b`).test(text);

  if (wildcard && !named) {
    // `.*` wires each port to the same-named net. The claim is only correct if
    // the port and the net have the same name.
    if (net === m.port) { results.PASS++; }
    else { results.FAIL++; notes.push(`FAIL (wildcard name mismatch) ${label}`); }
    continue;
  }

  if (named) {
    const idx = text.search(new RegExp(`\\.\\s*${m.port}\\b`));
    const after = text.slice(idx + text.slice(idx).match(new RegExp(`\\.\\s*${m.port}\\b`))[0].length);
    // Implicit named (`.clk`) has no parens before the next `,` or `)`.
    const nextParen = after.indexOf('(');
    const nextComma = after.search(/[,)]/);
    if (nextParen < 0 || (nextComma >= 0 && nextComma < nextParen)) {
      if (net === m.port) { results.PASS++; }
      else { results.FAIL++; notes.push(`FAIL (implicit-named mismatch) ${label}`); }
      continue;
    }
    const actual = parenSlice(after, nextParen);
    if (actual === null) { results.UNCHECKED++; notes.push(`UNCHECKED (unbalanced) ${label}`); continue; }
    if (new RegExp(`\\b${net}\\b`).test(actual)) { results.PASS++; }
    else { results.FAIL++; notes.push(`FAIL (net not in actual) ${label}  actual="${actual.trim().slice(0, 60)}"`); }
    continue;
  }

  // Positional: find the port's ordinal in the child's own header, then check
  // the Kth comma-separated actual of the instantiation.
  const childModule = path.basename(portFile).replace(/\.(sv|svh|v|vh|inc)$/i, '');
  let order = portOrder(portFile, m.instanceType || '');
  if (!order) {
    // The child module name is not carried on the edge; recover it from the
    // statement's leading identifier (`<type> <instance> (`).
    const typeMatch = text.match(new RegExp(`([A-Za-z_]\\w*)\\s+${m.instance}\\s*\\(`));
    if (typeMatch) order = portOrder(portFile, typeMatch[1]);
  }
  if (!order) { results.UNCHECKED++; notes.push(`UNCHECKED (no child header: ${childModule}) ${label}`); continue; }
  const k = order.indexOf(m.port);
  if (k < 0) { results.UNCHECKED++; notes.push(`UNCHECKED (port not in header) ${label}`); continue; }
  const conns = parenSlice(text, text.search(new RegExp(`\\b${m.instance}\\s*\\(`)));
  if (conns === null) { results.UNCHECKED++; notes.push(`UNCHECKED (no conn list) ${label}`); continue; }
  const parts = splitTopLevel(conns);
  const slot = parts[k];
  if (slot === undefined) { results.FAIL++; notes.push(`FAIL (ordinal past end) ${label}`); continue; }
  if (new RegExp(`\\b${net}\\b`).test(slot)) { results.PASS++; }
  else { results.FAIL++; notes.push(`FAIL (positional mismatch) ${label}  slot${k}="${slot.trim().slice(0, 60)}"`); }
}

/** Split on commas that are not inside (), [] or {}. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const checked = results.PASS + results.FAIL;
console.log(`population: ${edges.length} connects edges`);
console.log(`sample:     every ${stride}th edge by id -> ${sample.length} edges`);
console.log(`PASS ${results.PASS} · FAIL ${results.FAIL} · UNCHECKED ${results.UNCHECKED}`);
console.log(`precision:  ${checked ? ((results.PASS / checked) * 100).toFixed(1) : 'n/a'}%  (PASS / (PASS+FAIL))`);
if (notes.length) {
  console.log('\n-- non-PASS rows --');
  for (const n of notes.slice(0, 40)) console.log('  ' + n);
  if (notes.length > 40) console.log(`  ... +${notes.length - 40} more`);
}
