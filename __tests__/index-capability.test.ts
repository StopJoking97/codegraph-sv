/**
 * The wrong-index guard.
 *
 * Anchored on two synthetic censuses: an RTL index
 * (extraction 26) against a workspace index one level up (extraction
 * 25). The second one carries `drives` but ZERO `reads`/`connects`/`hier_ref`,
 * which is why a net-tracing question answered from it returns noise rather
 * than a weak answer.
 */

import { describe, it, expect } from 'vitest';
import {
  capabilityGap,
  capabilityGapMessage,
  capabilityOf,
  edgeKindsForQuery,
  formatCensus,
  TRACE_EDGE_KINDS,
  type IndexCapability,
} from '../src/index-capability';

/** The RTL index: every SV edge kind present. */
const RTL: IndexCapability = {
  root: '/w/proj/rtl',
  extractionVersion: 26,
  fileCount: 12,
  edgesByKind: {
    drives: 530, contains: 410, reads: 370, connects: 190,
    references: 85, calls: 45, instantiates: 23, hier_ref: 11, imports: 4,
  },
};

/** The workspace index: drives only, no reads/connects/hier_ref. */
const WORKSPACE: IndexCapability = {
  root: '/w/proj',
  extractionVersion: 25,
  fileCount: 40,
  edgesByKind: {
    contains: 820, drives: 640, calls: 470,
    references: 150, imports: 36, instantiates: 29, decorates: 8,
  },
};

describe('edgeKindsForQuery', () => {
  it('maps driver questions onto drives + connects', () => {
    // `connects` matters: in RTL most of a port's drivers arrive through the
    // instantiation hookup, not an assign in the same module.
    expect(edgeKindsForQuery('who drives cfg_rx_en').sort())
      .toEqual(['connects', 'drives']);
    expect(edgeKindsForQuery('what writes this signal')).toContain('drives');
  });

  it('maps reader questions onto reads', () => {
    expect(edgeKindsForQuery('who reads the enable bit')).toContain('reads');
    expect(edgeKindsForQuery('which modules consume cfg_tx_offset')).toContain('reads');
  });

  it('maps instantiation questions onto instantiates', () => {
    expect(edgeKindsForQuery('what instantiates sync_fifo')).toContain('instantiates');
    expect(edgeKindsForQuery('instances of MEM_A')).toContain('instantiates');
  });

  it('returns nothing for questions no single edge kind decides', () => {
    // The gate must stay silent on ordinary work, or it becomes noise the
    // reader learns to skip — and then it cannot warn about anything.
    expect(edgeKindsForQuery('how does authentication work')).toEqual([]);
    expect(edgeKindsForQuery('explain the retry logic')).toEqual([]);
  });
});

describe('capabilityGap', () => {
  it('is null when the index holds every required kind', () => {
    expect(capabilityGap(RTL, TRACE_EDGE_KINDS.readers)).toBeNull();
    expect(capabilityGap(RTL, TRACE_EDGE_KINDS.drivers)).toBeNull();
    expect(capabilityGap(RTL, TRACE_EDGE_KINDS.instances)).toBeNull();
  });

  it('flags a TOTAL gap when the index holds none of the required kinds', () => {
    // "who reads X" needs reads+connects; the workspace index has neither.
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.readers);
    expect(gap).not.toBeNull();
    expect(gap!.missing.sort()).toEqual(['connects', 'reads']);
    expect(gap!.total).toBe(true);
  });

  it('flags a PARTIAL gap when only some required kinds are present', () => {
    // "who drives X" needs drives+connects; the workspace index has drives
    // only, so it answers half the question and must not imply it answered
    // all of it.
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.drivers);
    expect(gap).not.toBeNull();
    expect(gap!.missing).toEqual(['connects']);
    expect(gap!.present).toEqual(['drives']);
    expect(gap!.total).toBe(false);
  });

  it('does not fire when nothing is required', () => {
    expect(capabilityGap(WORKSPACE, [])).toBeNull();
  });

  it('treats a kind absent from the census as zero, not as unknown', () => {
    // `reads` has no row at all in the workspace census. Absent must mean
    // zero: reading it as "unmeasured, assume fine" is the silent failure.
    expect(WORKSPACE.edgesByKind.reads).toBeUndefined();
    expect(capabilityGap(WORKSPACE, ['reads'])!.missing).toEqual(['reads']);
  });
});

describe('capabilityGapMessage', () => {
  it('names the resolved index, the census, and the index that can answer', () => {
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.readers)!;
    const msg = capabilityGapMessage(gap, {
      subject: 'status_reg',
      alternatives: [RTL],
      retargetAs: 'projectPath',
    });

    expect(msg).toContain('WRONG INDEX');
    expect(msg).toContain('/w/proj');           // what was resolved
    expect(msg).toContain('extraction 25');        // and how stale it is
    expect(msg).toContain('status_reg');    // what was asked
    expect(msg).toContain('drives 640');          // what it DOES hold
    expect(msg).toContain('ZERO');
    expect(msg).toContain('/w/proj/rtl'); // what to use instead
    expect(msg).toMatch(/Re-run with: projectPath/);
  });

  it('says INCOMPLETE rather than WRONG for a partial gap', () => {
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.drivers)!;
    const msg = capabilityGapMessage(gap, { alternatives: [RTL] });
    expect(msg).toContain('INCOMPLETE INDEX');
    expect(msg).not.toContain('WRONG INDEX');
    expect(msg).toContain('it does hold `drives`');
  });

  it('never proposes an alternative that is missing the same edges', () => {
    // Pointing at a second index that also cannot answer would just move the
    // wrong answer, so a useless alternative is reported as useless.
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.readers)!;
    const sibling: IndexCapability = { ...WORKSPACE, root: '/w/other' };
    const msg = capabilityGapMessage(gap, { alternatives: [sibling] });
    expect(msg).toContain('none holds the missing edges either');
    expect(msg).not.toMatch(/Re-run with/);
  });

  it('renders the CLI retarget as a --path flag', () => {
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.readers)!;
    const msg = capabilityGapMessage(gap, { alternatives: [RTL], retargetAs: '--path' });
    expect(msg).toContain('Re-run with: --path "/w/proj/rtl"');
  });

  it('is actionable even when no other index exists', () => {
    const gap = capabilityGap(WORKSPACE, TRACE_EDGE_KINDS.readers)!;
    const msg = capabilityGapMessage(gap, {});
    expect(msg).toContain('No other indexed project is reachable');
    expect(msg).toContain('projectPath');
  });
});

describe('formatCensus', () => {
  it('orders by count and omits zero-count kinds', () => {
    expect(formatCensus({ drives: 10, reads: 0, connects: 5 })).toBe('drives 10 · connects 5');
  });

  it('says so when there are no edges at all', () => {
    expect(formatCensus({})).toBe('(no edges)');
  });
});

describe('capabilityOf', () => {
  it('reads root, extraction version and census off an open index', () => {
    const cap = capabilityOf({
      getProjectRoot: () => '/w/p',
      getIndexBuildInfo: () => ({ version: '1.6.0', extractionVersion: 26 }),
      getStats: () => ({ fileCount: 12, edgesByKind: { drives: 1 } }),
    });
    expect(cap).toEqual({
      root: '/w/p', extractionVersion: 26, fileCount: 12, edgesByKind: { drives: 1 },
    });
  });
});
