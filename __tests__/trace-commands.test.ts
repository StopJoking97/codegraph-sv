/**
 * Deterministic trace queries: who drives / who reads / what instantiates.
 *
 * The fixture mirrors the edge shapes the SV extractor emits,
 * because the shapes are the part that is easy to get subtly wrong:
 *   drives       source = the enclosing MODULE, target = the field; edge.line
 *                is the assignment site.
 *   reads        source = the reading MODULE, target = the field; metadata
 *                carries EVERY read line, `{lines:[3,8], readCount:2}`.
 *   connects     source and target are both FIELDS; metadata carries
 *                `{port, portDirection, instance}`; an `input` hookup runs
 *                parent-net → child-port, an `output` hookup runs
 *                child-port → parent-net.
 *   instantiates source = parent module, target = child module; metadata
 *                carries `{instance}`.
 */

import { describe, it, expect } from 'vitest';
import { whoDrives, whoReads, instancesOf, siteCount, type TraceSource } from '../src/trace';
import type { Edge, Node } from '../src/types';

function node(id: string, name: string, kind: Node['kind'], filePath: string, startLine: number): Node {
  return { id, name, kind, filePath, startLine, endLine: startLine } as Node;
}

function edge(source: string, target: string, kind: Edge['kind'], line: number, metadata?: Record<string, unknown>): Edge {
  return { source, target, kind, line, metadata } as Edge;
}

/** A hand-built graph with the real shapes; no DB, no ranking, no I/O. */
function makeGraph(nodes: Node[], edges: Edge[], census: Record<string, number>): TraceSource {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByNameSubstring: (sub) =>
      nodes.filter((n) => n.name.includes(sub)).sort((a, b) => a.name.length - b.name.length),
    getNode: (id) => byId.get(id) ?? null,
    getIncomingEdges: (id) => edges.filter((e) => e.target === id),
    getOutgoingEdges: (id) => edges.filter((e) => e.source === id),
    getStats: () => ({ edgesByKind: census as never }),
  };
}

// --- The hookup-only shape: a port driven ONLY through instantiation hookups. --------
// `cfg_rx_en` is an input port of rx_top with no assign anywhere;
// its three drivers are the `rd_ready` hookups in mid_top.
const q1 = makeGraph(
  [
    node('f:rxen', 'cfg_rx_en', 'field', 'rtl/rx_top.v', 4),
    node('f:rrdy', 'rd_ready', 'field', 'rtl/mid_top.v', 12),
    node('m:cblk', 'ctrl_blk', 'module', 'rtl/ctrl_blk.v', 1),
  ],
  [
    edge('f:rrdy', 'f:rxen', 'connects', 110, { port: 'cfg_rx_en', portDirection: 'input', instance: 'u_rx0' }),
    edge('f:rrdy', 'f:rxen', 'connects', 123, { port: 'cfg_rx_en', portDirection: 'input', instance: 'u_rx1' }),
    edge('f:rrdy', 'f:rxen', 'connects', 131, { port: 'cfg_rx_en', portDirection: 'input', instance: 'u_rx2' }),
    edge('m:cblk', 'f:rrdy', 'drives', 64),
  ],
  { drives: 530, connects: 19, reads: 370, hier_ref: 11, instantiates: 2 },
);

describe('whoDrives', () => {
  it('finds drivers that arrive ONLY through port hookups', () => {
    const r = whoDrives(q1, 'cfg_rx_en');
    expect(siteCount(r)).toBe(3);
    expect(r.matches[0]!.sites.map((s) => s.line)).toEqual([110, 123, 131]);
    // The site is located at the HOOKUP, in the parent's file — not at the
    // port declaration, which tells a debugger nothing.
    expect(r.matches[0]!.sites[0]).toMatchObject({
      peer: 'rd_ready', via: 'connects', filePath: 'rtl/mid_top.v',
    });
    expect(r.matches[0]!.sites[0]!.detail).toContain('u_rx0.cfg_rx_en input');
  });

  it('finds an in-module assignment driver and reports its statement line', () => {
    const r = whoDrives(q1, 'rd_ready');
    expect(siteCount(r)).toBe(1);
    expect(r.matches[0]!.sites[0]).toMatchObject({
      peer: 'ctrl_blk', via: 'drives', line: 64,
    });
  });

  it('flags a hierarchical reference instead of claiming it is a driver', () => {
    // The graph resolves a dotted path but does not record read-vs-write, so
    // presenting it as a proven driver would be a fabricated fact.
    const g = makeGraph(
      [node('f:s', 'sig', 'field', 'a.v', 5), node('m:tb', 'tb', 'module', 'tb.v', 1)],
      [edge('m:tb', 'f:s', 'hier_ref', 362, { path: 'top.u0.sig' })],
      { drives: 10, connects: 5, hier_ref: 2 },
    );
    const site = whoDrives(g, 'sig').matches[0]!.sites[0]!;
    expect(site.via).toBe('hier_ref');
    expect(site.ambiguous).toBe(true);
    expect(site.detail).toBe('top.u0.sig');
  });

  it('reports an inout hookup as a driver from both directions', () => {
    const g = makeGraph(
      [node('f:a', 'SDA', 'field', 'top.v', 19), node('f:b', 'SDA', 'field', 'i2c_model.v', 3)],
      [edge('f:a', 'f:b', 'connects', 20, { port: 'SDA', portDirection: 'inout', bidirectional: true, instance: 'u_i2c_model' })],
      { drives: 1, connects: 1 },
    );
    const r = whoDrives(g, 'SDA');
    // Both nodes report the shared bidirectional site: on a bus, either end
    // can be the driver, and the graph is honest that it cannot say which.
    expect(siteCount(r)).toBe(2);
    for (const m of r.matches) expect(m.sites[0]!.ambiguous).toBe(true);
    expect(r.matches[0]!.sites[0]!.detail).toContain('inout');
  });
});

describe('whoReads', () => {
  it('expands every read line, not just the edge line', () => {
    // One edge, four reads. Collapsing to the edge line would hide three
    // places a debugger has to look.
    const g = makeGraph(
      [node('f:c', 'mem_clk', 'field', 'lib/MEM_OUT_X.v', 7), node('m:a', 'MEM_OUT_X', 'module', 'lib/MEM_OUT_X.v', 6)],
      [edge('m:a', 'f:c', 'reads', 3, { lines: [3, 8, 9, 17], readCount: 4 })],
      { reads: 370, connects: 19, hier_ref: 11 },
    );
    const r = whoReads(g, 'mem_clk');
    expect(siteCount(r)).toBe(4);
    expect(r.matches[0]!.sites.map((s) => s.line)).toEqual([3, 8, 9, 17]);
  });

  it('counts an outbound port hookup as a reader', () => {
    // A net wired into a child instance's input IS consumed there.
    const r = whoReads(q1, 'rd_ready');
    const viaConnects = r.matches[0]!.sites.filter((s) => s.via === 'connects');
    expect(viaConnects).toHaveLength(3);
    expect(viaConnects[0]!.peer).toBe('cfg_rx_en');
  });

  it('falls back to the edge line when metadata carries no line list', () => {
    const g = makeGraph(
      [node('f:x', 'x', 'field', 'a.v', 1), node('m:m', 'm', 'module', 'a.v', 1)],
      [edge('m:m', 'f:x', 'reads', 7)],
      { reads: 1, connects: 0 },
    );
    expect(whoReads(g, 'x').matches[0]!.sites[0]!.line).toBe(7);
  });
});

describe('instancesOf', () => {
  const g = makeGraph(
    [
      node('m:mema', 'MEM_A_64X32', 'module', 'lib/MEM_A.v', 9),
      node('m:memb', 'MEM_B_64X32', 'module', 'lib/MEM_B.v', 9),
      node('m:atx', 'buf_tx', 'module', 'rtl/buf_tx.v', 1),
    ],
    [
      edge('m:atx', 'm:mema', 'instantiates', 345, { instance: 'u_buf0' }),
      edge('m:atx', 'm:mema', 'instantiates', 379, { instance: 'u_buf1' }),
    ],
    { instantiates: 2 },
  );

  it('lists each instantiation site with its instance name', () => {
    const r = instancesOf(g, 'MEM_A_64X32');
    expect(siteCount(r)).toBe(2);
    expect(r.matches[0]!.sites.map((s) => `${s.filePath}:${s.line} ${s.detail}`)).toEqual([
      'rtl/buf_tx.v:345 u_buf0',
      'rtl/buf_tx.v:379 u_buf1',
    ]);
  });

  it('PROVES absence for an orphan module, with the denominator', () => {
    // The whole point: "nothing instantiates this" is a result, and the
    // caller can check the claim because the edge population is stated.
    const r = instancesOf(g, 'MEM_B_64X32');
    expect(r.matches).toHaveLength(1);      // the module IS indexed …
    expect(siteCount(r)).toBe(0);           // … and nothing instantiates it
    expect(r.edgesConsulted).toBe(2);     // out of this many edges examined
  });

  it('distinguishes "name not indexed" from "indexed but never instantiated"', () => {
    // Two different facts. Conflating them is how a typo reads as an orphan.
    const r = instancesOf(g, 'MEM_B');
    expect(r.matches).toHaveLength(0);
    expect(r.nearMisses.map((n) => n.name)).toContain('MEM_B_64X32');
  });
});

describe('result contract', () => {
  it('reports the edge population every answer was derived from', () => {
    expect(whoDrives(q1, 'cfg_rx_en').edgesConsulted).toBe(530 + 19 + 11);
    expect(whoReads(q1, 'cfg_rx_en').edgesConsulted).toBe(370 + 19 + 11);
    expect(instancesOf(q1, 'anything').edgesConsulted).toBe(2);
  });

  it('orders sites by file then line, never by a relevance score', () => {
    const g = makeGraph(
      [node('f:s', 'sig', 'field', 'z.v', 1), node('m:b', 'b', 'module', 'b.v', 1), node('m:a', 'a', 'module', 'a.v', 1)],
      [edge('m:b', 'f:s', 'drives', 10), edge('m:a', 'f:s', 'drives', 99), edge('m:a', 'f:s', 'drives', 5)],
      { drives: 3, connects: 0, hier_ref: 0 },
    );
    expect(whoDrives(g, 'sig').matches[0]!.sites.map((s) => `${s.filePath}:${s.line}`))
      .toEqual(['a.v:5', 'a.v:99', 'b.v:10']);
  });

  it('returns a match per same-named node so a legacy twin is never merged', () => {
    // `tx_dat_o` exists in both a current block and a legacy
    // copy. Merging them would attribute the legacy driver to the new
    // block — the exact misdirection this command exists to prevent.
    const g = makeGraph(
      [node('f:new', 'tx_dat_o', 'field', 'rtl/tx_top.v', 50),
       node('f:old', 'tx_dat_o', 'field', 'rtl/tx_legacy.v', 15),
       node('m:new', 'tx_top', 'module', 'rtl/tx_top.v', 1),
       node('m:old', 'tx_legacy', 'module', 'rtl/tx_legacy.v', 1)],
      [edge('m:new', 'f:new', 'drives', 51), edge('m:old', 'f:old', 'drives', 21)],
      { drives: 2, connects: 0, hier_ref: 0 },
    );
    const r = whoDrives(g, 'tx_dat_o');
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.sites[0]!.line).sort()).toEqual([21, 51]);
  });
});
