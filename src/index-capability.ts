/**
 * Index capability — can the index we resolved actually answer this question?
 *
 * The failure this exists to stop: a server that resolved its index from the
 * session cwd answers a signal-tracing question out of a *different*, poorer
 * index, and the answer is indistinguishable from a good one. For example, a
 * workspace index one directory up may carry
 * `drives` but ZERO `reads`, `connects` and `hier_ref` edges, so "who reads
 * this register bit" there is not a hard question — it is an unanswerable one.
 * It still produced ranked files, all of them wrong.
 *
 * The rule below is deliberately blunt: an index holding zero edges of a kind
 * cannot answer a question that is only decidable from that kind. That is
 * arithmetic, not heuristics, and it is what makes the gate safe to fire — a
 * TypeScript index answering a TypeScript `calls` question has thousands of
 * `calls` edges and never trips it.
 */

import type { EdgeKind } from './types';

/**
 * The slice of `CodeGraph` a census needs. Structural rather than an import of
 * the class, so this module stays a leaf and `src/index.ts` can depend on it
 * without a cycle.
 */
export interface CensusSource {
  getProjectRoot(): string;
  getIndexBuildInfo(): { version: string | null; extractionVersion: number | null };
  getStats(): { fileCount: number; edgesByKind: Partial<Record<EdgeKind, number>> };
}

/** Census an open index. */
export function capabilityOf(cg: CensusSource): IndexCapability {
  const stats = cg.getStats();
  return {
    root: cg.getProjectRoot(),
    extractionVersion: cg.getIndexBuildInfo().extractionVersion,
    edgesByKind: stats.edgesByKind,
    fileCount: stats.fileCount,
  };
}

/** Edge-kind census plus the provenance a reader needs to judge it. */
export interface IndexCapability {
  /** Project root whose `.codegraph/` produced this census. */
  root: string;
  /** `EXTRACTION_VERSION` the index was built at, or null when unstamped. */
  extractionVersion: number | null;
  /** Edge count per kind. Kinds absent from the index may be absent here. */
  edgesByKind: Partial<Record<EdgeKind, number>>;
  /** Indexed file count, for the one-line summary. */
  fileCount: number;
}

/** What a capability check found missing, or null when the index can answer. */
export interface CapabilityGap {
  /** Edge kinds the query needs that the index holds ZERO of. */
  missing: EdgeKind[];
  /** Edge kinds the query needs that the index does hold. */
  present: EdgeKind[];
  /** The index that was checked. */
  capability: IndexCapability;
  /**
   * True when NONE of the required kinds are present — the index provably
   * cannot answer, so a result set from it is noise, not a partial answer.
   */
  total: boolean;
}

/**
 * Edge kinds that decide each trace question. `who-drives` needs `connects`
 * as well as `drives` because in RTL the majority of a port's drivers arrive
 * through the instantiation hookup, not through an `assign` in the same
 * module — an index with `drives` but no `connects` answers the question
 * half-blind and says so nowhere.
 */
export const TRACE_EDGE_KINDS: Record<'drivers' | 'readers' | 'instances' | 'follow', EdgeKind[]> = {
  drivers: ['drives', 'connects'],
  readers: ['reads', 'connects'],
  instances: ['instantiates'],
  // Following a net across module walls is `connects` to cross and `drives` to
  // stop, so it is decidable from exactly what `drivers` needs.
  follow: ['drives', 'connects'],
};

/**
 * Which edge kinds a free-text query is only decidable from.
 *
 * Conservative by design: it returns kinds ONLY for phrasings whose answer
 * lives in a specific edge kind, and returns `[]` for everything else. A false
 * positive here costs a spurious banner; a false negative costs nothing beyond
 * today's behaviour. Matching is on intent words, not on HDL vocabulary, so
 * "who writes this variable" is caught in any language — the gate then stays
 * silent unless the index genuinely holds none of the kind.
 */
export function edgeKindsForQuery(query: string): EdgeKind[] {
  const q = query.toLowerCase();
  const kinds = new Set<EdgeKind>();
  // "who drives / what drives / who writes / who assigns / driver of"
  if (/\b(driv(e|es|er|ers|ing|en)|writes?|written|assigns?|assigned)\b/.test(q)) {
    kinds.add('drives');
    kinds.add('connects');
  }
  // "who reads / readers of / consumes / fan-out / who uses this signal"
  if (/\b(reads?|readers?|consum(e|es|er|ers|ed)|fan-?out|sinks?)\b/.test(q)) {
    kinds.add('reads');
  }
  // "what is it wired to / port hookup / connected to"
  if (/\b(wired|wiring|hook-?up|hooked|connect(s|ed|ion|ions)?|ports?)\b/.test(q)) {
    kinds.add('connects');
  }
  // "what instantiates X / instances of X"
  if (/\b(instantiat(e|es|ed|ion|ions)|instances? of|instanced)\b/.test(q)) {
    kinds.add('instantiates');
  }
  // "hierarchical reference / dotted path / backdoor"
  if (/\b(hierarchical|hier[_ ]?ref|dotted path|backdoor)\b/.test(q)) {
    kinds.add('hier_ref');
  }
  return [...kinds];
}

/**
 * Compare what a query needs against what an index holds. Returns null when
 * every required kind is present (or nothing was required).
 */
export function capabilityGap(
  capability: IndexCapability,
  required: EdgeKind[],
): CapabilityGap | null {
  if (required.length === 0) return null;
  const missing = required.filter((k) => (capability.edgesByKind[k] ?? 0) === 0);
  if (missing.length === 0) return null;
  const present = required.filter((k) => (capability.edgesByKind[k] ?? 0) > 0);
  return { missing, present, capability, total: present.length === 0 };
}

/** `drives 530 · reads 370 · connects 190` — the census, densest kinds first. */
export function formatCensus(edgesByKind: Partial<Record<EdgeKind, number>>): string {
  const rows = Object.entries(edgesByKind)
    .filter(([, c]) => (c ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (rows.length === 0) return '(no edges)';
  return rows.map(([k, c]) => `${k} ${c}`).join(' · ');
}

/**
 * The loud message. It names the index that was resolved, what it is missing,
 * and the exact re-run that would answer the question — the three things a
 * user would otherwise have to reconstruct by hand.
 *
 * `alternatives` are other indexed roots reachable from here; each is rendered
 * with its own census so the reader can see which one actually has the edges,
 * rather than being told to guess.
 */
export function capabilityGapMessage(
  gap: CapabilityGap,
  opts: {
    /** What the caller asked, echoed so the message stands alone in a log. */
    subject?: string;
    /** Other indexed roots, best-first, with their censuses. */
    alternatives?: IndexCapability[];
    /** How to re-target: 'projectPath' (MCP tool arg) or '--path' (CLI flag). */
    retargetAs?: 'projectPath' | '--path';
  } = {},
): string {
  const { capability: cap, missing, present, total } = gap;
  const retarget = opts.retargetAs ?? 'projectPath';
  const lines: string[] = [];

  lines.push(
    total
      ? 'WRONG INDEX — this index cannot answer that question.'
      : 'INCOMPLETE INDEX — this index can only answer that question in part.',
  );
  if (opts.subject) lines.push(`Asked about: ${opts.subject}`);
  lines.push(
    `Resolved index: ${cap.root} ` +
      `(extraction ${cap.extractionVersion ?? 'unstamped'}, ${cap.fileCount} files)`,
  );
  lines.push(`  edges: ${formatCensus(cap.edgesByKind)}`);
  lines.push(
    `  answering this needs ${missing.map((k) => `\`${k}\``).join(' + ')}, ` +
      `of which it holds ZERO` +
      (present.length ? ` (it does hold ${present.map((k) => `\`${k}\``).join(', ')})` : ''),
  );

  const alts = (opts.alternatives ?? []).filter((a) => a.root !== cap.root);
  const better = alts.filter((a) => missing.every((k) => (a.edgesByKind[k] ?? 0) > 0));
  if (better.length > 0) {
    lines.push('Indexes reachable from here that DO hold those edges:');
    for (const a of better) {
      lines.push(
        `  ${a.root} (extraction ${a.extractionVersion ?? 'unstamped'}) — ${formatCensus(a.edgesByKind)}`,
      );
    }
    const first = better[0]!;
    lines.push(
      retarget === '--path'
        ? `Re-run with: --path "${first.root}"`
        : `Re-run with: ${retarget}: "${first.root.replace(/\\/g, '/')}"`,
    );
  } else if (alts.length > 0) {
    lines.push('Other indexes reachable from here (none holds the missing edges either):');
    for (const a of alts) {
      lines.push(
        `  ${a.root} (extraction ${a.extractionVersion ?? 'unstamped'}) — ${formatCensus(a.edgesByKind)}`,
      );
    }
    lines.push(
      `No reachable index can answer this. Either the right project is not indexed, ` +
        `or its index predates the edge kinds involved — re-index it, then retry.`,
    );
  } else {
    lines.push(
      `No other indexed project is reachable from here. Pass ${retarget} pointing at the ` +
        `project that holds this code, or re-index it if the index predates these edge kinds.`,
    );
  }

  return lines.join('\n');
}
