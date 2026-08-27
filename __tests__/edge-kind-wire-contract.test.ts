/**
 * Wire-contract tests for EDGE_KINDS / NODE_KINDS.
 *
 * The kind tables are ordered and append-only: an entry's INDEX is the on-wire
 * byte value written into the kernel's edge/ref rows, and the Rust kernel keeps
 * a mirror of both tables including a fixed-length array literal. A desync does
 * not fail loudly — it silently relabels every existing edge of an adjacent
 * kind, which is why the mirror is asserted here rather than only inside the
 * kernel-scaffold suite (that suite skips whenever the .node is not built, so
 * it cannot be the contract's only guard).
 *
 * These assertions read the Rust SOURCE, so they hold with or without a Rust
 * toolchain installed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EDGE_KINDS, NODE_KINDS } from '../src/types';

const BUFFERS_RS = path.join(__dirname, '..', 'codegraph-kernel', 'src', 'buffers.rs');

/** The entries of `pub const <NAME>: [&str; N] = [ ... ];`, plus its declared N. */
function rustTable(name: string): { entries: string[]; declaredLen: number } {
  const src = fs.readFileSync(BUFFERS_RS, 'utf8');
  const re = new RegExp(`pub const ${name}: \\[&str; (\\d+)\\] = \\[([\\s\\S]*?)\\];`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} not found in ${BUFFERS_RS}`);
  const entries = [...m[2]!.matchAll(/"([^"]*)"/g)].map((e) => e[1]!);
  return { entries, declaredLen: Number(m[1]) };
}

describe('EDGE_KINDS wire contract', () => {
  it('has 16 entries with the three HDL connectivity kinds at 13, 14 and 15', () => {
    expect(EDGE_KINDS.length).toBe(16);
    expect(EDGE_KINDS[13]).toBe('connects');
    expect(EDGE_KINDS[14]).toBe('reads');
    expect(EDGE_KINDS[15]).toBe('hier_ref');
    // The prefix is frozen: anything that moves an existing kind's index
    // relabels every edge of that kind already on disk.
    expect(EDGE_KINDS.slice(0, 13)).toEqual([
      'contains', 'calls', 'imports', 'exports', 'extends', 'implements',
      'references', 'type_of', 'returns', 'instantiates', 'overrides',
      'decorates', 'drives',
    ]);
  });

  it('matches the Rust mirror byte-for-byte, length literal included', () => {
    const rust = rustTable('EDGE_KINDS');
    expect(rust.declaredLen).toBe(16);
    expect(rust.entries).toEqual([...EDGE_KINDS]);
    expect(rust.entries.length).toBe(rust.declaredLen);
  });

  it('keeps the NODE_KINDS mirror in sync too', () => {
    const rust = rustTable('NODE_KINDS');
    expect(rust.entries).toEqual([...NODE_KINDS]);
    expect(rust.declaredLen).toBe(NODE_KINDS.length);
  });

  it('has no duplicate kind names in either table', () => {
    expect(new Set(EDGE_KINDS).size).toBe(EDGE_KINDS.length);
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
  });
});
