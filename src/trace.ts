/**
 * Deterministic trace queries — who drives a net, who reads it, what
 * instantiates a module.
 *
 * These answer from EDGES ALONE. No FTS, no relevance score, no ranking, no
 * budget that could drop the one row that mattered: an exact name lookup in
 * the node index, then every edge incident to what it found. Two consequences
 * the ranked surface cannot offer:
 *
 *   - The answer is complete or it is an error. There is no "top N" to fall
 *     off the bottom of, which is the defect that put the sole consumer of
 *     an exactly named register field below three files containing zero
 *     occurrences of it.
 *   - Absence is a RESULT. "Nothing instantiates `sync_fifo`" is a fact the graph
 *     can prove — every `instantiates` edge is checked and none points at it — and
 *     proving it is the whole reason a verification engineer reaches for a
 *     graph over grep. Silence proves nothing, so these never return silence.
 */

import type { Edge, EdgeKind, Node } from './types';
import { TRACE_EDGE_KINDS } from './index-capability';

/** How a site relates to the subject. */
export type TraceVia = 'drives' | 'connects' | 'reads' | 'hier_ref' | 'instantiates';

/** One place the subject is driven / read / instantiated. */
export interface TraceSite {
  /** The other end: the driving scope, the reading scope, the peer port. */
  peer: string;
  /** Node kind of `peer` (module, field, …). */
  peerKind: string;
  /**
   * File containing the SITE — the `assign`/`always`/hookup/instantiation
   * statement. For a `drives` or `reads` edge that is the driving scope's own
   * file; for `connects` it is the file the instantiation is written in.
   */
  filePath: string;
  /**
   * Line of the statement, never of a declaration. A module spans its whole
   * file, so its `startLine` locates nothing a debugger can use.
   */
  line: number | null;
  via: TraceVia;
  /** `u_buf0.A0 input`, `top.u_sub.dat`, or undefined. */
  detail?: string;
  /**
   * Set when the graph does NOT distinguish direction for this site, so the
   * caller must not present it as a proven driver or a proven reader.
   */
  ambiguous?: boolean;
}

/** One node that carried the queried name, plus everything incident to it. */
export interface TraceMatch {
  node: Node;
  sites: TraceSite[];
}

export interface TraceResult {
  /** The name as asked. */
  subject: string;
  /** What the question was. */
  question: 'drivers' | 'readers' | 'instances';
  /** Every node with EXACTLY this name. Empty when the name is not indexed. */
  matches: TraceMatch[];
  /** Edge kinds consulted to produce this answer. */
  kindsConsulted: EdgeKind[];
  /**
   * How many edges of those kinds the whole index holds. This is the
   * denominator of the absence proof: zero sites out of N examined edges is
   * evidence; zero sites out of zero edges is a capability gap.
   */
  edgesConsulted: number;
  /**
   * Populated ONLY when `matches` is empty: other indexed names that contain
   * the queried string, so an exact-name miss is a lead rather than a wall.
   * A LIKE scan, not a ranking — order is shortest-name-first, deterministic.
   */
  nearMisses: Node[];
}

/** The subset of `CodeGraph` these queries use. */
export interface TraceSource {
  getNodesByName(name: string): Node[];
  getNodesByNameSubstring(
    substring: string,
    options?: { kinds?: Node['kind'][]; limit?: number; excludePrefix?: boolean },
  ): Node[];
  getNode(id: string): Node | null;
  getIncomingEdges(nodeId: string): Edge[];
  getOutgoingEdges(nodeId: string): Edge[];
  getStats(): { edgesByKind: Partial<Record<EdgeKind, number>> };
}

/** `u_buf0.A0 input`, or the best partial label the metadata supports. */
function connectDetail(edge: Edge): string {
  const m = (edge.metadata ?? {}) as {
    instance?: string;
    port?: string;
    portDirection?: string;
    bidirectional?: boolean;
  };
  const what = m.instance && m.port ? `${m.instance}.${m.port}` : (m.port ?? 'port');
  const dir = m.bidirectional ? 'inout' : m.portDirection;
  return dir ? `${what} ${dir}` : what;
}

/** True for a port connection the graph itself marks as bidirectional. */
function isBidirectional(edge: Edge): boolean {
  const m = (edge.metadata ?? {}) as { bidirectional?: boolean; portDirection?: string };
  return m.bidirectional === true || m.portDirection === 'inout';
}

/**
 * Sites are ordered by file then line — a stable, content-derived order. It is
 * NOT a relevance ranking and must never become one: the caller is entitled to
 * read the list as the complete set, in source order.
 */
function sortSites(sites: TraceSite[]): TraceSite[] {
  return sites.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0),
  );
}

function siteFrom(
  peer: Node | null,
  edge: Edge,
  via: TraceVia,
  fallbackFile: string,
  extra: { detail?: string; line?: number | null; ambiguous?: boolean } = {},
): TraceSite {
  return {
    peer: peer?.name ?? '(unresolved node)',
    peerKind: peer?.kind ?? 'unknown',
    // A `drives`/`reads` edge is written inside the driving scope, so the site
    // file is the peer's. A `connects` edge is written at the instantiation,
    // which lives in the parent — also the peer's file when the peer is the
    // parent net, but the subject's when the peer is the child port. The edge
    // carries no file of its own, so prefer the peer and fall back to the
    // subject rather than inventing one.
    filePath: peer?.filePath ?? fallbackFile,
    line: extra.line !== undefined ? extra.line : (edge.line ?? null),
    via,
    detail: extra.detail,
    ambiguous: extra.ambiguous,
  };
}

function census(cg: TraceSource, kinds: EdgeKind[]): number {
  const byKind = cg.getStats().edgesByKind;
  return kinds.reduce((n, k) => n + (byKind[k] ?? 0), 0);
}

function nearMissesFor(cg: TraceSource, name: string): Node[] {
  try {
    return cg.getNodesByNameSubstring(name, { limit: 10 });
  } catch {
    return [];
  }
}

/**
 * Everything that drives `name`.
 *
 * Two mechanisms, both reported, because in RTL a port's driver is usually
 * neither alone:
 *   - `drives` — an `assign` or an `always` block writing it in its own scope.
 *   - `connects` INBOUND — the instantiation hookup that feeds this port from
 *     a parent net (or feeds this net from a child's output).
 * `hier_ref` sites are included and flagged `ambiguous`: the graph resolves the
 * dotted path but does not record whether that reference read or wrote.
 */
export function whoDrives(cg: TraceSource, name: string): TraceResult {
  const kinds = [...TRACE_EDGE_KINDS.drivers, 'hier_ref' as EdgeKind];
  const nodes = cg.getNodesByName(name);
  const matches: TraceMatch[] = nodes.map((node) => {
    const sites: TraceSite[] = [];
    for (const edge of cg.getIncomingEdges(node.id)) {
      const peer = cg.getNode(edge.source);
      if (edge.kind === 'drives') {
        sites.push(siteFrom(peer, edge, 'drives', node.filePath));
      } else if (edge.kind === 'connects') {
        sites.push(
          siteFrom(peer, edge, 'connects', node.filePath, {
            detail: connectDetail(edge),
            ambiguous: isBidirectional(edge) || undefined,
          }),
        );
      } else if (edge.kind === 'hier_ref') {
        const m = (edge.metadata ?? {}) as { path?: string };
        sites.push(
          siteFrom(peer, edge, 'hier_ref', node.filePath, { detail: m.path, ambiguous: true }),
        );
      }
    }
    // An inout hookup drives this net from the far side as well, and outbound
    // is where that edge is recorded when this node is the connection source.
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'connects' || !isBidirectional(edge)) continue;
      sites.push(
        siteFrom(cg.getNode(edge.target), edge, 'connects', node.filePath, {
          detail: connectDetail(edge),
          ambiguous: true,
        }),
      );
    }
    return { node, sites: sortSites(sites) };
  });

  return {
    subject: name,
    question: 'drivers',
    matches,
    kindsConsulted: kinds,
    edgesConsulted: census(cg, kinds),
    nearMisses: matches.length === 0 ? nearMissesFor(cg, name) : [],
  };
}

/**
 * Everything that reads `name`.
 *
 * `reads` edge metadata carries every read line in the scope
 * (`{lines:[3,8,9,17]}`), so one edge becomes one site PER LINE — a reader
 * that touches a signal four times is four places a debugger has to look, and
 * collapsing them to the edge's first line would hide three of them.
 */
export function whoReads(cg: TraceSource, name: string): TraceResult {
  const kinds = [...TRACE_EDGE_KINDS.readers, 'hier_ref' as EdgeKind];
  const nodes = cg.getNodesByName(name);
  const matches: TraceMatch[] = nodes.map((node) => {
    const sites: TraceSite[] = [];
    for (const edge of cg.getIncomingEdges(node.id)) {
      const peer = cg.getNode(edge.source);
      if (edge.kind === 'reads') {
        const m = (edge.metadata ?? {}) as { lines?: number[] };
        const lines = m.lines?.length ? m.lines : [edge.line ?? null];
        for (const line of lines) {
          sites.push(siteFrom(peer, edge, 'reads', node.filePath, { line }));
        }
      } else if (edge.kind === 'connects' && isBidirectional(edge)) {
        sites.push(
          siteFrom(peer, edge, 'connects', node.filePath, {
            detail: connectDetail(edge),
            ambiguous: true,
          }),
        );
      } else if (edge.kind === 'hier_ref') {
        const m = (edge.metadata ?? {}) as { path?: string };
        sites.push(
          siteFrom(peer, edge, 'hier_ref', node.filePath, { detail: m.path, ambiguous: true }),
        );
      }
    }
    // Outbound `connects`: this net is wired INTO something — a child
    // instance's input port, or a parent net fed by this output. Either way
    // its value is consumed there, which is what "who reads it" asks.
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'connects') continue;
      sites.push(
        siteFrom(cg.getNode(edge.target), edge, 'connects', node.filePath, {
          detail: connectDetail(edge),
          ambiguous: isBidirectional(edge) || undefined,
        }),
      );
    }
    return { node, sites: sortSites(sites) };
  });

  return {
    subject: name,
    question: 'readers',
    matches,
    kindsConsulted: kinds,
    edgesConsulted: census(cg, kinds),
    nearMisses: matches.length === 0 ? nearMissesFor(cg, name) : [],
  };
}

/**
 * Every instantiation site of module `name`.
 *
 * Zero sites on a module that IS indexed is the orphan-module answer — a fact,
 * and one grep can only approximate by counting text occurrences.
 */
export function instancesOf(cg: TraceSource, name: string): TraceResult {
  const kinds = TRACE_EDGE_KINDS.instances;
  const nodes = cg.getNodesByName(name);
  const matches: TraceMatch[] = nodes.map((node) => {
    const sites: TraceSite[] = [];
    for (const edge of cg.getIncomingEdges(node.id)) {
      if (edge.kind !== 'instantiates') continue;
      const m = (edge.metadata ?? {}) as { instance?: string };
      sites.push(
        siteFrom(cg.getNode(edge.source), edge, 'instantiates', node.filePath, {
          detail: m.instance,
        }),
      );
    }
    return { node, sites: sortSites(sites) };
  });

  return {
    subject: name,
    question: 'instances',
    matches,
    kindsConsulted: kinds,
    edgesConsulted: census(cg, kinds),
    nearMisses: matches.length === 0 ? nearMissesFor(cg, name) : [],
  };
}

/** Total sites across every match — the count an absence proof negates. */
export function siteCount(result: TraceResult): number {
  return result.matches.reduce((n, m) => n + m.sites.length, 0);
}
