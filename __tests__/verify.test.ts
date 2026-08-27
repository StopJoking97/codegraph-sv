/**
 * `codegraph verify` — the pass that grades the index against an independent
 * compiler front-end.
 *
 * Everything here runs WITHOUT the grader installed. That is deliberate: the
 * degradation paths are the part that must never break, because a verification
 * pass that can block a teammate is worse than no verification pass. The
 * classifier and the conditional-region mapper are pure and are tested directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyFile,
  conditionalRegions,
  inConditionalRegion,
  summarize,
  scopeFiles,
  formatVerifyReport,
  verifyExitCode,
  runGrader,
  oracleScriptPath,
  ORACLE_PROTOCOL,
  SUPPORTED_ORACLE_MAJORS,
  type FileVerdict,
  type IndexedFile,
} from '../src/verify';
import { clearProjectConfigCache, loadVerifyConfig } from '../src/project-config';

describe('verify — conditional-region mapper', () => {
  it('covers an `ifdef block from its directive to its `endif, inclusive', () => {
    const src = [
      'module m;',      // 1
      '`ifdef FPGA',    // 2
      '  wire a;',      // 3
      '`else',          // 4
      '  wire b;',      // 5
      '`endif',         // 6
      '  wire c;',      // 7
      'endmodule',      // 8
    ].join('\n');
    const regions = conditionalRegions(src);
    expect(regions).toEqual([{ start: 2, end: 6 }]);
    expect(inConditionalRegion(3, regions)).toBe(true);
    expect(inConditionalRegion(5, regions)).toBe(true);
    // The directive lines themselves count: a declaration sharing a line with a
    // directive is still conditional.
    expect(inConditionalRegion(2, regions)).toBe(true);
    expect(inConditionalRegion(6, regions)).toBe(true);
    expect(inConditionalRegion(7, regions)).toBe(false);
  });

  it('handles `ifndef and nesting', () => {
    const src = [
      '`ifndef GUARD',   // 1
      '`ifdef INNER',    // 2
      'wire x;',         // 3
      '`endif',          // 4
      'wire y;',         // 5
      '`endif',          // 6
    ].join('\n');
    const regions = conditionalRegions(src);
    expect(regions).toEqual([{ start: 1, end: 6 }, { start: 2, end: 4 }]);
    expect(inConditionalRegion(3, regions)).toBe(true);
    expect(inConditionalRegion(5, regions)).toBe(true);
  });

  it('runs an unbalanced `ifdef to end of file rather than dropping it', () => {
    // Over-reporting a region is the safe direction: it can only turn an
    // UNEXPLAINED tripwire back into an expected BRANCH-UNION, never the other
    // way round.
    const src = ['`ifdef OPEN', 'wire a;', 'wire b;'].join('\n');
    expect(conditionalRegions(src)).toEqual([{ start: 1, end: 3 }]);
  });

  it('is a no-op on a file with no directives at all', () => {
    expect(conditionalRegions('module m;\n  wire a;\nendmodule\n')).toEqual([]);
    expect(inConditionalRegion(1, [])).toBe(false);
    expect(inConditionalRegion(undefined, [{ start: 1, end: 9 }])).toBe(false);
  });

  it('ignores a backtick that is not a conditional directive', () => {
    const src = ['`define W 8', '`include "defs.vh"', '`timescale 1ns/1ps'].join('\n');
    expect(conditionalRegions(src)).toEqual([]);
  });
});

describe('verify — three-way classifier', () => {
  const indexed = (entries: [string, number][]): IndexedFile => new Map(entries);

  it('reports a name the grader has and the index does not as MISSING', () => {
    const v = classifyFile('a.v', { scope: ['clk', 'rstn'], local: [] }, indexed([['clk', 3]]), []);
    expect(v.graded).toBe(2);
    expect(v.hit).toBe(1);
    expect(v.disagreements).toEqual([{ file: 'a.v', name: 'rstn', verdict: 'MISSING' }]);
  });

  it('reports an index-only name inside a conditional region as BRANCH-UNION', () => {
    // This is the FEATURE: the index covers the union of all branches so an
    // agent can find code in a branch that is not currently compiled.
    const v = classifyFile(
      'a.v',
      { scope: ['clk'], local: [] },
      indexed([['clk', 1], ['fpga_only', 5]]),
      [{ start: 4, end: 6 }]
    );
    expect(v.disagreements).toEqual([
      { file: 'a.v', name: 'fpga_only', line: 5, verdict: 'BRANCH-UNION' },
    ]);
  });

  it('reports an index-only name with no conditional region as UNEXPLAINED', () => {
    const v = classifyFile('a.v', { scope: ['clk'], local: [] }, indexed([['clk', 1], ['ghost', 9]]), []);
    expect(v.disagreements).toEqual([
      { file: 'a.v', name: 'ghost', line: 9, verdict: 'UNEXPLAINED' },
    ]);
  });

  it('excludes procedural-local names on BOTH sides', () => {
    // The index does not carry procedural locals by design. Counting one as
    // MISSING would report a deliberate scope boundary as a defect; counting an
    // index-side one as UNEXPLAINED would fire the tripwire on a boundary both
    // sides agree about.
    const v = classifyFile(
      'a.v',
      { scope: ['clk'], local: ['tmp', 'i'] },
      indexed([['clk', 1], ['tmp', 20]]),
      []
    );
    expect(v.graded).toBe(1);
    expect(v.hit).toBe(1);
    expect(v.disagreements).toEqual([]);
  });

  it('does not fire the tripwire on a preprocessor symbol', () => {
    // A `define is NOT a declaration: slang consumes it during preprocessing, so
    // a macro name can never enter the graded population no matter how the
    // oracle is configured. verifyIndex drops macro-only names before
    // classifying — a real design can carry many — because reporting each
    // as UNEXPLAINED is a population error, not a finding. The classifier itself
    // stays honest: anything it IS handed and cannot explain still fires.
    const v = classifyFile('a.v', { scope: ['clk'], local: [] }, indexed([['clk', 1], ['ghost', 9]]), []);
    expect(v.disagreements.map((d) => d.verdict)).toEqual(['UNEXPLAINED']);
  });

  it('summarizes per-class totals across files', () => {
    const files: FileVerdict[] = [
      classifyFile('a.v', { scope: ['x', 'y'], local: [] }, indexed([['x', 1]]), []),
      classifyFile('b.v', { scope: [], local: [] }, indexed([['cond', 3], ['ghost', 9]]), [{ start: 2, end: 4 }]),
    ];
    const s = summarize(files);
    expect(s.graded).toBe(2);
    expect(s.hit).toBe(1);
    expect(s.missing).toBe(1);
    expect(s.branchUnion).toBe(1);
    expect(s.unexplained).toBe(1);
  });
});

describe('verify — scoping is mandatory and can only narrow', () => {
  const indexedPaths = ['rtl/a.sv', 'rtl/sub/b.v', 'ip/fpga/lib/huge.v', 'tb/t.sv'];

  it('grades every indexed file when no globs are configured', () => {
    expect(scopeFiles(indexedPaths, [], [])).toEqual([
      'ip/fpga/lib/huge.v',
      'rtl/a.sv',
      'rtl/sub/b.v',
      'tb/t.sv',
    ]);
  });

  it('narrows to an include glob', () => {
    expect(scopeFiles(indexedPaths, ['rtl/**'], [])).toEqual(['rtl/a.sv', 'rtl/sub/b.v']);
  });

  it('drops an exclude glob — the vendor-tree case that motivated scoping', () => {
    expect(scopeFiles(indexedPaths, [], ['ip/fpga/lib/**'])).toEqual([
      'rtl/a.sv',
      'rtl/sub/b.v',
      'tb/t.sv',
    ]);
  });

  it('never widens beyond what the index contains', () => {
    // A glob naming a path the index does not hold adds nothing: grading a tool
    // on files it was never asked to index produces a meaningless number.
    expect(scopeFiles(indexedPaths, ['**/*.v', 'never/indexed/**'], [])).toEqual([
      'ip/fpga/lib/huge.v',
      'rtl/sub/b.v',
    ]);
  });

  it('normalizes backslash paths so a Windows index scopes the same way', () => {
    expect(scopeFiles(['rtl\\a.sv'], ['rtl/**'], [])).toEqual(['rtl/a.sv']);
  });
});

describe('verify — project config', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-verify-cfg-'));
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify(obj));

  it('reports "not configured" with no codegraph.json at all', () => {
    const cfg = loadVerifyConfig(dir);
    expect(cfg.configured).toBe(false);
    expect(cfg.includeDirs).toEqual([]);
    expect(cfg.defines).toEqual({});
  });

  it('reads include dirs, defines and globs from the EXISTING project config', () => {
    write({
      verify: {
        includeDirs: ['rtl/include', 'macro'],
        defines: { SYNTHESIS: '1', FPGA: '' },
        include: ['rtl/**'],
        exclude: ['ip/fpga/**'],
      },
    });
    const cfg = loadVerifyConfig(dir);
    expect(cfg.configured).toBe(true);
    expect(cfg.includeDirs).toEqual(['rtl/include', 'macro']);
    expect(cfg.defines).toEqual({ SYNTHESIS: '1', FPGA: '' });
    expect(cfg.include).toEqual(['rtl/**']);
    expect(cfg.exclude).toEqual(['ip/fpga/**']);
  });

  it('degrades a malformed block to "not configured" rather than throwing', () => {
    write({ verify: { includeDirs: 'not-an-array', defines: ['also', 'wrong'] } });
    expect(loadVerifyConfig(dir).configured).toBe(false);
  });

  it('drops a define whose name is not a macro identifier', () => {
    write({ verify: { defines: { GOOD: '1', 'rm -rf /': 'x' } } });
    expect(loadVerifyConfig(dir).defines).toEqual({ GOOD: '1' });
  });

  it('leaves the rest of the config untouched', () => {
    write({ extensions: { '.foo': 'lua' }, verify: { includeDirs: ['inc'] } });
    expect(loadVerifyConfig(dir).includeDirs).toEqual(['inc']);
  });
});

describe('verify — degradation paths (no grader installed)', () => {
  const job = { root: process.cwd(), files: [], includeDirs: [], defines: {}, timeoutMs: 5000 };

  it('ships the oracle script with the build', () => {
    // The script is resolved relative to the module, so a published package and
    // a from-source run must both find it.
    expect(oracleScriptPath()).not.toBeNull();
  });

  it('skips — never throws — when no Python interpreter exists', () => {
    const saved = process.env.CODEGRAPH_VERIFY_PYTHON;
    process.env.CODEGRAPH_VERIFY_PYTHON = path.join(os.tmpdir(), 'definitely-not-a-real-python');
    try {
      const outcome = runGrader(job);
      expect(outcome.status).toBe('skipped');
      if (outcome.status === 'skipped') expect(outcome.reason).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_VERIFY_PYTHON;
      else process.env.CODEGRAPH_VERIFY_PYTHON = saved;
    }
  });

  it('skips when the grader exits non-zero', () => {
    const script = path.join(os.tmpdir(), `cg-verify-fail-${process.pid}.js`);
    fs.writeFileSync(script, 'process.stderr.write("boom\\n"); process.exit(7);\n');
    const saved = process.env.CODEGRAPH_VERIFY_PYTHON;
    process.env.CODEGRAPH_VERIFY_PYTHON = process.execPath;
    try {
      // Point the interpreter at node and let it run the real oracle path; the
      // oracle script is Python, so node exits non-zero — exactly the shape of a
      // grader that failed.
      const outcome = runGrader(job);
      expect(outcome.status).toBe('skipped');
    } finally {
      fs.rmSync(script, { force: true });
      if (saved === undefined) delete process.env.CODEGRAPH_VERIFY_PYTHON;
      else process.env.CODEGRAPH_VERIFY_PYTHON = saved;
    }
  });

  it('skips when the grader exceeds its budget', () => {
    const saved = process.env.CODEGRAPH_VERIFY_PYTHON;
    // A node interpreter that never reads stdin and never exits.
    const stall = path.join(os.tmpdir(), `cg-verify-stall-${process.pid}.js`);
    fs.writeFileSync(stall, 'setInterval(() => {}, 1000);\n');
    process.env.CODEGRAPH_VERIFY_PYTHON = process.execPath;
    try {
      const outcome = runGrader({ ...job, timeoutMs: 250 });
      // Either the timeout or the non-zero exit — both are skips, never throws,
      // and both keep the exit code at success.
      expect(outcome.status).toBe('skipped');
    } finally {
      fs.rmSync(stall, { force: true });
      if (saved === undefined) delete process.env.CODEGRAPH_VERIFY_PYTHON;
      else process.env.CODEGRAPH_VERIFY_PYTHON = saved;
    }
  });

  it('renders a skip as guidance, and its exit code is SUCCESS', () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'pyslang is not installed (pip install "pyslang==11.*")',
      staleFiles: [],
      scopedFiles: 41,
    };
    const text = formatVerifyReport(outcome);
    expect(text).toContain('SKIPPED');
    expect(text).toContain('pyslang');
    expect(text).toContain('41');
    // Never blocking, even in strict mode: a teammate without the grader must
    // not be stopped by it.
    expect(verifyExitCode(outcome, true)).toBe(0);
    expect(verifyExitCode(outcome, false)).toBe(0);
  });

  it('still reports stale index entries when the grader is unavailable', () => {
    // The defect class that produced confidently WRONG answers: an index that
    // answers about a file which no longer exists.
    const text = formatVerifyReport({
      status: 'skipped',
      reason: 'pyslang is not installed',
      staleFiles: ['sim/old_tb.sv'],
      scopedFiles: 41,
    });
    expect(text).toContain('STALE');
    expect(text).toContain('sim/old_tb.sv');
  });
});

describe('verify — report rendering and exit codes', () => {
  const okOutcome = (
    over: Partial<{ missing: number; unexplained: number; configured: boolean; version: string; notes: string[] }> = {}
  ) => {
    const missing = over.missing ?? 0;
    const files: FileVerdict[] = [
      {
        file: 'a.v',
        graded: 10,
        hit: 10 - missing,
        disagreements: [
          ...Array.from({ length: missing }, (_, i) => ({
            file: 'a.v',
            name: `gone${i}`,
            verdict: 'MISSING' as const,
          })),
          ...Array.from({ length: over.unexplained ?? 0 }, (_, i) => ({
            file: 'a.v',
            name: `ghost${i}`,
            line: 40 + i,
            verdict: 'UNEXPLAINED' as const,
          })),
        ],
      },
    ];
    return {
      status: 'ok' as const,
      report: {
        oracle: 'pyslang',
        version: over.version ?? `${SUPPORTED_ORACLE_MAJORS[0]}.0.0`,
        mode: 'syntax-only' as const,
        notes: over.notes ?? [],
        files: { 'a.v': { scope: [], local: [] } },
        parseFailed: [],
        notOnDisk: [],
        versionWarning:
          over.version && !SUPPORTED_ORACLE_MAJORS.includes(Number(over.version.split('.')[0]))
            ? 'version outside the validated range'
            : undefined,
      },
      result: summarize(files),
      staleFiles: [],
      scopedFiles: 1,
      configured: over.configured ?? true,
      parseFailed: [],
    };
  };

  it('prints the three-way classification with a recall figure', () => {
    const text = formatVerifyReport(okOutcome());
    expect(text).toContain('DESIGN-SCOPE RECALL   10 / 10   100.0%');
    expect(text).toContain('MISSING       0');
    expect(text).toContain('BRANCH-UNION  0');
    expect(text).toContain('UNEXPLAINED   0');
  });

  it('states which mode it ran in when the project supplied no config', () => {
    expect(formatVerifyReport(okOutcome({ configured: false }))).toContain('SYNTAX-ONLY');
    expect(formatVerifyReport(okOutcome({ configured: true }))).not.toContain('mode: SYNTAX-ONLY');
  });

  it('says so wherever recall is reported that procedural locals are excluded', () => {
    // Three different recall numbers are all true and measure different things;
    // printing one without saying which is misleading even though it is correct.
    expect(formatVerifyReport(okOutcome())).toContain('Procedural-local declarations are excluded');
  });

  it('prints what the oracle could NOT apply rather than overstating its rigour', () => {
    // pyslang 11 exposes include directories but no way to predefine macros from
    // Python. A configured `defines` block that silently did nothing would make
    // a loose grade read as a strict one.
    const text = formatVerifyReport(
      okOutcome({ notes: ['pyslang 11.0.0 exposes no way to predefine macros from Python'] })
    );
    expect(text).toContain('note: pyslang 11.0.0 exposes no way to predefine macros');
  });

  it('reports a version outside the validated range rather than tolerating it', () => {
    const text = formatVerifyReport(okOutcome({ version: '99.0.0' }));
    expect(text).toContain('VERSION');
  });

  it('exits non-zero in strict mode on any MISSING, and zero otherwise', () => {
    expect(verifyExitCode(okOutcome({ missing: 1 }), true)).toBe(1);
    expect(verifyExitCode(okOutcome({ missing: 1 }), false)).toBe(0);
    expect(verifyExitCode(okOutcome({ missing: 0 }), true)).toBe(0);
    // UNEXPLAINED is a tripwire for the classifier, not a recall bug, so it does
    // not fail the build on its own.
    expect(verifyExitCode(okOutcome({ unexplained: 3 }), true)).toBe(0);
  });

  it('lists MISSING and UNEXPLAINED names so they can be acted on', () => {
    const text = formatVerifyReport(okOutcome({ missing: 2, unexplained: 1 }));
    expect(text).toContain('MISSING declarations:');
    expect(text).toContain('gone0');
    expect(text).toContain('UNEXPLAINED names');
    expect(text).toContain('ghost0');
  });
});

describe('verify — oracle protocol', () => {
  it('pins the protocol version the bundled script speaks', () => {
    const script = oracleScriptPath();
    expect(script).not.toBeNull();
    const source = fs.readFileSync(script!, 'utf8');
    expect(source).toContain(`PROTOCOL = ${ORACLE_PROTOCOL}`);
  });
});
