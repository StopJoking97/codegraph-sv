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

/** Which way a follow walks: toward the writer, or toward the consumers. */
export type FollowDirection = 'upstream' | 'downstream';

/** One module wall crossed, or the statement the walk ended at. */
export interface FollowHop {
  /** The net's name on the FAR side of this wall — its name after the rename. */
  name: string;
  kind: string;
  /** Where that net is declared. */
  declaredIn: string;
  declaredLine: number | null;
  via: 'connects' | 'drives';
  /** The hookup or assignment statement — the line a debugger opens. */
  siteFile: string;
  siteLine: number | null;
  /** `u_rx0.cfg_rx_en input`. */
  detail?: string;
  /** True when the name CHANGED crossing this wall — where grep stops working. */
  renamed?: boolean;
  /** Walls crossed so far, 0 for the first. */
  depth: number;
  /** The graph does not record this hop's direction (an inout, a dotted path). */
  ambiguous?: boolean;
  /** This net was already expanded above; shown, not re-walked. */
  revisit?: boolean;
}

/**
 * Why a walk stopped. Never "it just ended" — silence proves nothing.
 *
 * `no-driver` and `no-connections` are deliberately separate: a net that
 * crossed three walls and never reached a writer is a different fact from a net
 * that is wired to nothing at all, and reporting both as one number is how a
 * capability gap gets mistaken for a design fact.
 */
export type FollowStop = 'driver' | 'no-driver' | 'no-connections' | 'depth-limit' | 'cycle';

export interface FollowMatch {
  node: Node;
  /** Depth-first, so a branch reads as a chain. */
  hops: FollowHop[];
  stop: FollowStop;
}

export interface FollowResult {
  subject: string;
  question: 'follow';
  direction: FollowDirection;
  matches: FollowMatch[];
  kindsConsulted: EdgeKind[];
  edgesConsulted: number;
  nearMisses: Node[];
}

/** Hard stop on hierarchy depth; real designs rarely chain more than a few levels. */
const FOLLOW_MAX_DEPTH = 16;

/**
 * Follow a net across module walls, through every rename, to the statement that
 * writes it — or, downstream, to everything it reaches.
 *
 * `who-drives` answers exactly ONE wall. That is correct and it is not enough:
 * an engineer holding the leaf name they actually know (`go_in`, or
 * `cfg_rx_en`) gets back a DIFFERENT name (`start_req`, `rd_ready`)
 * and has to re-query by hand, once per wall, guessing each new name — which is
 * precisely the knowledge they lacked when they started. A net can sit several
 * walls from its writer and change its name at each one. This walks it for them.
 *
 * The walk is the same edges the other trace commands read, in the same
 * ranking-free way: `connects` to cross a wall, `drives` to end. Nothing is
 * scored, nothing is truncated to a top N.
 *
 * A net already expanded is emitted as a `revisit` hop and not walked again —
 * three instantiations of the same child share one upstream chain, and printing
 * it three times would bury the answer rather than complete it. Marking beats
 * dropping: the hop is still there to see.
 */
export function followNet(
  cg: TraceSource,
  name: string,
  direction: FollowDirection = 'upstream',
): FollowResult {
  const kinds: EdgeKind[] = ['drives', 'connects'];
  const nodes = cg.getNodesByName(name);

  const matches: FollowMatch[] = nodes.map((root) => {
    const hops: FollowHop[] = [];
    const expanded = new Set<string>([root.id]);
    // The nets on the CURRENT path. A net already expanded on a SIBLING branch
    // is a revisit — the same chain reached twice, which is ordinary in RTL
    // where one net feeds three instances. Only a net already on the path
    // being walked is a cycle. Conflating them reports "cycle" on a perfectly
    // acyclic design, which is a wrong answer about the design itself.
    const onPath = new Set<string>([root.id]);
    let sawDriver = false;
    let hitDepth = false;
    let sawCycle = false;

    const step = (fromId: string, fromName: string, depth: number): void => {
      if (depth >= FOLLOW_MAX_DEPTH) {
        hitDepth = true;
        return;
      }
      // Upstream reads what feeds this net; downstream reads what it feeds. An
      // inout hookup carries data both ways, so it is walked in whichever
      // direction is being asked and flagged rather than silently trusted.
      const inbound = cg.getIncomingEdges(fromId);
      const outbound = cg.getOutgoingEdges(fromId);
      const edges =
        direction === 'upstream'
          ? [...inbound, ...outbound.filter((e) => e.kind === 'connects' && isBidirectional(e))]
          : [...outbound, ...inbound.filter((e) => e.kind === 'connects' && isBidirectional(e))];

      for (const edge of edges) {
        // A `drives` edge only ever ends an UPSTREAM walk: downstream, the
        // writer is where we came from, not somewhere we are going.
        if (edge.kind === 'drives') {
          if (direction !== 'upstream') continue;
          const writer = cg.getNode(edge.source);
          sawDriver = true;
          hops.push({
            name: writer?.name ?? '(unresolved node)',
            kind: writer?.kind ?? 'unknown',
            declaredIn: writer?.filePath ?? '',
            declaredLine: writer?.startLine ?? null,
            via: 'drives',
            siteFile: writer?.filePath ?? '',
            siteLine: edge.line ?? null,
            depth,
          });
          continue;
        }
        if (edge.kind !== 'connects') continue;

        const peerId = edge.source === fromId ? edge.target : edge.source;
        const peer = cg.getNode(peerId);
        const peerName = peer?.name ?? '(unresolved node)';
        const already = expanded.has(peerId);
        if (onPath.has(peerId)) sawCycle = true;
        hops.push({
          name: peerName,
          kind: peer?.kind ?? 'unknown',
          declaredIn: peer?.filePath ?? '',
          declaredLine: peer?.startLine ?? null,
          via: 'connects',
          // The hookup is written in the file the INSTANTIATION lives in, which
          // the edge's own line locates; the peer's file is where that net is
          // declared. Both are printed because they are different questions.
          siteFile: peer?.filePath ?? root.filePath,
          siteLine: edge.line ?? null,
          detail: connectDetail(edge),
          renamed: peerName !== fromName || undefined,
          depth,
          ambiguous: isBidirectional(edge) || undefined,
          revisit: already || undefined,
        });
        if (already) continue;
        expanded.add(peerId);
        onPath.add(peerId);
        step(peerId, peerName, depth + 1);
        onPath.delete(peerId);
      }
    };

    step(root.id, root.name, 0);

    const stop: FollowStop = sawDriver
      ? 'driver'
      : sawCycle
        ? 'cycle'
        : hitDepth
          ? 'depth-limit'
          : hops.length === 0
            ? 'no-connections'
            : 'no-driver';
    return { node: root, hops, stop };
  });

  return {
    subject: name,
    question: 'follow',
    direction,
    matches,
    kindsConsulted: kinds,
    edgesConsulted: census(cg, kinds),
    nearMisses: matches.length === 0 ? nearMissesFor(cg, name) : [],
  };
}

/** Total hops across every match — the count an absence proof negates. */
export function hopCount(result: FollowResult): number {
  return result.matches.reduce((n, m) => n + m.hops.length, 0);
}
