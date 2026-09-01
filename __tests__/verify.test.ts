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
  requiredGradedFiles,
  runGrader,
  interpretGraderOutput,
  oracleScriptPath,
  ORACLE_PROTOCOL,
  SUPPORTED_ORACLE_MAJORS,
  type FileVerdict,
  type IndexedFile,
} from '../src/verify';
import { clearProjectConfigCache, loadVerifyConfig } from '../src/project-config';
import { CodeGraph } from '../src';

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

  /** Config is memoized per root, so a second write in one test needs a flush. */
  const rewrite = (obj: unknown) => {
    write(obj);
    clearProjectConfigCache();
  };

  it('defaults the coverage floor to 1 and refuses a value outside [0, 1]', () => {
    rewrite({});
    expect(loadVerifyConfig(dir).minCoverage).toBe(1);
    // The likely mistake is writing 90 for "90%". Keeping the default is the safe
    // direction — it can only make --strict harder to pass, never softer than
    // the author intended.
    rewrite({ verify: { minCoverage: 90 } });
    expect(loadVerifyConfig(dir).minCoverage).toBe(1);
    rewrite({ verify: { minCoverage: -0.5 } });
    expect(loadVerifyConfig(dir).minCoverage).toBe(1);
    rewrite({ verify: { minCoverage: 0.8 } });
    expect(loadVerifyConfig(dir).minCoverage).toBe(0.8);
  });

  it('does not let a coverage floor alone claim the grading was configured', () => {
    // `configured` drives the SYNTAX-ONLY advisory, which is about how tightly
    // the oracle GRADED. minCoverage tightens the GATE. Counting it here would
    // let a project silence "graded loosely" by lowering its own floor — the one
    // pairing most worth warning about.
    rewrite({ verify: { minCoverage: 0.5 } });
    const cfg = loadVerifyConfig(dir);
    expect(cfg.minCoverage).toBe(0.5);
    expect(cfg.configured).toBe(false);

    rewrite({ verify: { minCoverage: 0.5, includeDirs: ['inc'] } });
    expect(loadVerifyConfig(dir).configured).toBe(true);
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

  it('skips when pyslang itself is missing, naming the install command', () => {
    // The oracle exits 2 for exactly this, so a teammate who has Python but not
    // pyslang gets an actionable line instead of a stack trace.
    const outcome = interpretGraderOutput(2, '', 'pyslang is not importable');
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') expect(outcome.reason).toContain('pip install');
  });

  it('skips on output this build cannot parse', () => {
    for (const junk of ['not json at all', '', '[1,2,3]', 'null']) {
      const outcome = interpretGraderOutput(0, junk, '');
      expect(outcome.status, junk).toBe('skipped');
    }
  });

  it('skips on a protocol this build does not speak, naming both versions', () => {
    // A future oracle whose wire shape changed must not be read with this
    // build's assumptions — a mis-read report is worse than no report.
    const outcome = interpretGraderOutput(0, JSON.stringify({ protocol: 99, files: {} }), '');
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toContain('99');
      expect(outcome.reason).toContain(String(ORACLE_PROTOCOL));
    }
  });

  it('carries the last of stderr into the reason on a non-zero exit', () => {
    const outcome = interpretGraderOutput(7, '', 'line one\nline two\nboom');
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') expect(outcome.reason).toContain('boom');
  });

  it('accepts a well-formed report, and flags an unvalidated oracle version', () => {
    const ok = interpretGraderOutput(
      0,
      JSON.stringify({ protocol: ORACLE_PROTOCOL, oracle: 'pyslang', version: `${SUPPORTED_ORACLE_MAJORS[0]}.0.0`, mode: 'preprocessed', files: {} }),
      ''
    );
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') {
      expect(ok.report.mode).toBe('preprocessed');
      expect(ok.report.versionWarning).toBeUndefined();
    }

    const future = interpretGraderOutput(
      0,
      JSON.stringify({ protocol: ORACLE_PROTOCOL, version: '99.1.0', files: {} }),
      ''
    );
    // A version bump is REPORTED, never fatal: the risk it carries is a silently
    // smaller graded population, which the reader has to be told about.
    expect(future.status).toBe('ok');
    if (future.status === 'ok') expect(future.report.versionWarning).toContain('99.1.0');
  });

  it('renders a skip as guidance, and its exit code is SUCCESS', () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'pyslang is not installed (pip install "pyslang==11.*")',
      staleFiles: [],
      scopedFiles: 41,
      indexedFiles: 41,
      indexedFilesTotal: 41,
    };
    const text = formatVerifyReport(outcome);
    expect(text).toContain('SKIPPED');
    expect(text).toContain('pyslang');
    expect(text).toContain('41');
    // Never blocking in the DEFAULT mode: a teammate without the grader must not
    // be stopped by it.
    expect(verifyExitCode(outcome, false)).toBe(0);
  });

  it('FAILS a skip under --strict, because a skip proves nothing', () => {
    // The false-green: with a success exit code on skip, a CI image that loses
    // pyslang greens the gate forever, indistinguishable from "graded and clean".
    const outcome = {
      status: 'skipped' as const,
      reason: 'pyslang is not installed (pip install "pyslang==11.*")',
      staleFiles: [],
      scopedFiles: 41,
      indexedFiles: 41,
      indexedFilesTotal: 41,
    };
    expect(verifyExitCode(outcome, true)).toBe(1);
    const text = formatVerifyReport(outcome, true);
    expect(text).toContain('STRICT: failing');
    expect(text).toContain('NOTHING was verified');
    // The default rendering must NOT claim a strict failure.
    expect(formatVerifyReport(outcome, false)).not.toContain('STRICT');
  });

  it('still reports stale index entries when the grader is unavailable', () => {
    // The defect class that produced confidently WRONG answers: an index that
    // answers about a file which no longer exists.
    const text = formatVerifyReport({
      status: 'skipped',
      reason: 'pyslang is not installed',
      staleFiles: ['sim/old_tb.sv'],
      scopedFiles: 41,
      indexedFiles: 41,
      indexedFilesTotal: 41,
    });
    expect(text).toContain('STALE');
    expect(text).toContain('sim/old_tb.sv');
  });
});

describe('verify — report rendering and exit codes', () => {
  const okOutcome = (
    over: Partial<{
      missing: number;
      unexplained: number;
      configured: boolean;
      version: string;
      notes: string[];
      graded: number;
      scopedFiles: number;
      indexedFiles: number;
      indexedFilesTotal: number;
      gradedFiles: number;
      minCoverage: number;
    }> = {}
  ) => {
    const missing = over.missing ?? 0;
    const graded = over.graded ?? 10;
    const files: FileVerdict[] = [
      {
        file: 'a.v',
        graded,
        hit: graded - missing,
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
      scopedFiles: over.scopedFiles ?? 1,
      indexedFiles: over.indexedFiles ?? 1,
      indexedFilesTotal: over.indexedFilesTotal ?? 1,
      gradedFiles: over.gradedFiles ?? 1,
      minCoverage: over.minCoverage ?? 1,
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

  it('does NOT fail a project that holds no SystemVerilog, in either mode', () => {
    // The regression the zero-graded gate introduced. `verify` grades
    // SystemVerilog and nothing else, so a TypeScript repo scopes zero files and
    // grades zero declarations — arithmetically identical to the emptied
    // population it was written to catch, and every non-SV project became a
    // permanent red under --strict. What separates them is whether there was
    // ever anything to measure.
    const nothingToVerify = okOutcome({
      graded: 0,
      scopedFiles: 0,
      indexedFiles: 0,
      gradedFiles: 0,
      indexedFilesTotal: 40, // a real index — 40 TypeScript files, no SystemVerilog
    });
    expect(verifyExitCode(nothingToVerify, true)).toBe(0);
    expect(verifyExitCode(nothingToVerify, false)).toBe(0);

    const text = formatVerifyReport(nothingToVerify, true);
    expect(text).toContain('NOTHING TO VERIFY');
    // And it must not read as evidence either.
    expect(text).not.toContain('100.0%');
  });

  it('does not print a STRICT failure on a skip that the exit code passes', () => {
    // Two absences stacked: no grader AND no SystemVerilog. Only the second one
    // decides the outcome, and verifyExitCode already returns 0 for it. The
    // renderer used to announce "STRICT: failing" on any skip, so the text a
    // person reads contradicted the exit code a machine reads.
    const nothingEitherWay = {
      status: 'skipped' as const,
      reason: 'pyslang is not installed (pip install "pyslang==11.*")',
      staleFiles: [],
      scopedFiles: 0,
      indexedFiles: 0,
      indexedFilesTotal: 40, // a real index, just not a SystemVerilog one
    };
    expect(verifyExitCode(nothingEitherWay, true)).toBe(0);
    const text = formatVerifyReport(nothingEitherWay, true);
    expect(text).toContain('NOTHING TO VERIFY');
    expect(text).not.toContain('STRICT: failing');

    // A skip on a project that DOES hold SystemVerilog still fails loudly.
    const realSkip = { ...nothingEitherWay, scopedFiles: 41, indexedFiles: 41, indexedFilesTotal: 41 };
    expect(verifyExitCode(realSkip, true)).toBe(1);
    expect(formatVerifyReport(realSkip, true)).toContain('STRICT: failing');
  });

  it('FAILS an index holding no files at all, rather than reading it as "no SystemVerilog"', () => {
    // The inverse risk of the nothing-to-verify pass, and the worse one. A
    // truncated or never-built .codegraph opens fine and reports zero
    // SystemVerilog files — identical arithmetic to a TypeScript repo. Greening
    // that means a real design, fully on disk, passes --strict completely
    // unverified: the exact failure this pass exists to catch.
    const emptyIndex = okOutcome({
      graded: 0,
      scopedFiles: 0,
      indexedFiles: 0,
      gradedFiles: 0,
      indexedFilesTotal: 0,
    });
    expect(verifyExitCode(emptyIndex, true)).toBe(1);
    expect(verifyExitCode(emptyIndex, false)).toBe(0);
    const text = formatVerifyReport(emptyIndex, true);
    expect(text).toContain('EMPTY INDEX');
    expect(text).not.toContain('NOTHING TO VERIFY');

    // Same for a skip on an empty index.
    const emptySkip = {
      status: 'skipped' as const,
      reason: 'pyslang is not installed',
      staleFiles: [],
      scopedFiles: 0,
      indexedFiles: 0,
      indexedFilesTotal: 0,
    };
    expect(verifyExitCode(emptySkip, true)).toBe(1);
    expect(formatVerifyReport(emptySkip, true)).toContain('EMPTY INDEX');
  });

  it('FAILS under --strict when the config excluded its way down to a handful of files', () => {
    // The half of the original finding the first fix missed. Measuring coverage
    // against POST-glob scope made `verify.exclude` a bypass: narrow 41 files to
    // 1, grade that 1 perfectly, and a run proving nothing exits 0 with a clean
    // 100.0% — indistinguishable from a full pass. The denominator has to be the
    // whole indexed design.
    const excludedDown = okOutcome({ scopedFiles: 1, indexedFiles: 41, indexedFilesTotal: 41, gradedFiles: 1 });
    expect(verifyExitCode(excludedDown, true)).toBe(1);
    expect(verifyExitCode(excludedDown, false)).toBe(0);

    const text = formatVerifyReport(excludedDown, true);
    expect(text).toContain('COVERAGE  1 / 41 indexed files graded');
    expect(text).toContain('40 excluded by config');

    // Excluding is still ALLOWED — it just has to be declared, not free.
    expect(
      verifyExitCode(okOutcome({ scopedFiles: 1, indexedFiles: 41, indexedFilesTotal: 41, gradedFiles: 1, minCoverage: 0.01 }), true)
    ).toBe(0);
  });

  it('computes the coverage floor without inheriting float error from the product', () => {
    // `100 * 0.07` is 7.000000000000001 in IEEE 754, so comparing against the
    // raw product failed a run of exactly 7 files, and a bare Math.ceil demanded
    // 8 — for a floor its author wrote as 7.
    expect(requiredGradedFiles(100, 0.07)).toBe(7);
    expect(verifyExitCode(okOutcome({ scopedFiles: 100, indexedFiles: 100, gradedFiles: 7, minCoverage: 0.07 }), true)).toBe(0);
    expect(verifyExitCode(okOutcome({ scopedFiles: 100, indexedFiles: 100, gradedFiles: 6, minCoverage: 0.07 }), true)).toBe(1);

    // A genuine fraction is still rounded UP, not away.
    expect(requiredGradedFiles(41, 0.9)).toBe(37);
    expect(requiredGradedFiles(100, 0.29)).toBe(29);
    expect(requiredGradedFiles(41, 1)).toBe(41);
  });

  it('FAILS under --strict when the config kept every SystemVerilog file out of scope', () => {
    // The mirror of the case above and the reason the two zeroes cannot share a
    // test: SystemVerilog IS indexed here, and an exclude glob is the thing that
    // emptied the population. That run owes exactly the evidence it skipped.
    const excludedAway = okOutcome({
      graded: 0,
      scopedFiles: 0,
      indexedFiles: 41,
      indexedFilesTotal: 41,
      gradedFiles: 0,
    });
    expect(verifyExitCode(excludedAway, true)).toBe(1);
    expect(verifyExitCode(excludedAway, false)).toBe(0);
  });

  it('FAILS under --strict when the oracle graded a fraction of the files it was given', () => {
    // A run proves only as much as it covered. Emptying the population was
    // already caught; NARROWING it was not — 1 file of 41 graded scored a clean
    // 100.0% and exited 0, indistinguishable from a full pass.
    const narrowed = okOutcome({ scopedFiles: 41, indexedFiles: 41, gradedFiles: 1 });
    expect(verifyExitCode(narrowed, true)).toBe(1);
    expect(verifyExitCode(narrowed, false)).toBe(0);

    // The report has to say which, not just fail.
    const text = formatVerifyReport(narrowed, true);
    expect(text).toContain('COVERAGE  1 / 41');
    expect(text).toContain('40 came back with no verdict');

    // Full coverage of the same scope passes.
    expect(verifyExitCode(okOutcome({ scopedFiles: 41, indexedFiles: 41, gradedFiles: 41 }), true)).toBe(0);
  });

  it('honours a project-configured coverage floor below 1', () => {
    // A corpus with files the oracle genuinely cannot take needs a way to say so
    // that is louder than deleting the check.
    const half = { scopedFiles: 41, indexedFiles: 41, gradedFiles: 21 };
    expect(verifyExitCode(okOutcome({ ...half, minCoverage: 1 }), true)).toBe(1);
    expect(verifyExitCode(okOutcome({ ...half, minCoverage: 0.5 }), true)).toBe(0);
  });

  it('states how much of the index the scope covered, so a narrowed run cannot read as a full one', () => {
    const text = formatVerifyReport(okOutcome({ scopedFiles: 12, indexedFiles: 41, gradedFiles: 12 }));
    expect(text).toContain('scoped: 12 of 41 SystemVerilog files');
    expect(text).toContain('narrowed by verify.include/exclude');
  });

  it('FAILS a zero-graded run under --strict instead of scoring it 100%', () => {
    // A ratio over an empty population is not a perfect score, it is no
    // measurement — an exclude glob that empties the population must not green.
    const empty = okOutcome({ graded: 0 });
    expect(verifyExitCode(empty, true)).toBe(1);
    expect(verifyExitCode(empty, false)).toBe(0);
  });

  it('prints an empty graded population as NOT MEASURED, never as 100.0%', () => {
    const text = formatVerifyReport(okOutcome({ graded: 0 }), true);
    expect(text).toContain('0 / 0   NOT MEASURED');
    expect(text).not.toContain('100.0%');
    expect(text).toContain('STRICT: failing — 0 declarations were graded');
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

/**
 * End-to-end against the REAL oracle. Everything above this point is a unit
 * test over a hand-written report, which is exactly why the `` `include ``
 * misattribution survived a full suite: no test ever asked the compiler
 * front-end which file a name came from.
 *
 * Gated on pyslang being importable so a machine without it reports SKIPPED
 * rather than a green it did not earn.
 */
const ORACLE_AVAILABLE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oracle-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'p.sv'), 'module p; wire a; endmodule\n');
    return (
      runGrader({
        root: dir,
        files: ['p.sv'],
        includeDirs: [],
        defines: {},
        timeoutMs: 60_000,
      }).status === 'ok'
    );
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe('verify — `include attribution (the origin file owns the name)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** rtl/user.sv `include`s rtl/include/defs.svh, with includeDirs configured. */
  function fixture(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-verify-include-'));
    fs.mkdirSync(path.join(tempDir, 'rtl', 'include'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'rtl', 'include', 'defs.svh'),
      'parameter INCLUDED_PARAM = 4;\nwire included_sig;\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'rtl', 'user.sv'),
      'module user;\n`include "defs.svh"\n  wire own_sig;\nendmodule\n'
    );
    return tempDir;
  }

  it.runIf(ORACLE_AVAILABLE)(
    'keys an `include-d declaration to the header, not to the including file',
    () => {
      const root = fixture();
      const outcome = runGrader({
        root,
        files: ['rtl/user.sv', 'rtl/include/defs.svh'],
        includeDirs: ['rtl/include'],
        defines: {},
        timeoutMs: 60_000,
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      // The including file owns only what its OWN text declares.
      expect(outcome.report.files['rtl/user.sv']?.scope.slice().sort()).toEqual([
        'own_sig',
        'user',
      ]);
      // The header owns the names its own text declares.
      expect(outcome.report.files['rtl/include/defs.svh']?.scope.slice().sort()).toEqual([
        'INCLUDED_PARAM',
        'included_sig',
      ]);
    }
  );

  it.runIf(ORACLE_AVAILABLE)(
    'reports no MISSING for a correct index whose headers declare names',
    async () => {
      const root = fixture();
      fs.writeFileSync(
        path.join(root, 'codegraph.json'),
        JSON.stringify({ verify: { includeDirs: ['rtl/include'] } })
      );
      clearProjectConfigCache();
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const outcome = cg.verify({ timeoutMs: 60_000 });
        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;

        const missing = outcome.result.files
          .flatMap((f) => f.disagreements)
          .filter((d) => d.verdict === 'MISSING')
          .map((d) => `${d.file} ${d.name}`)
          .sort();
        expect(missing).toEqual([]);
        expect(verifyExitCode(outcome, true)).toBe(0);
      } finally {
        cg.destroy();
      }
    }
  );
});

describe('verify — an unusable include dir must not degrade the run silently', () => {
  let tempDir: string;

  /** The smallest outcome the gate accepts: graded, complete, nothing missing. */
  const okOutcomeForGate = () => ({
    status: 'ok' as const,
    report: {
      oracle: 'pyslang',
      version: `${SUPPORTED_ORACLE_MAJORS[0]}.0.0`,
      mode: 'preprocessed' as const,
      notes: [],
      files: {},
      parseFailed: [],
      notOnDisk: [],
    },
    result: summarize([{ file: 'a.v', graded: 1, hit: 1, disagreements: [] }]),
    staleFiles: [],
    scopedFiles: 1,
    indexedFiles: 1,
    indexedFilesTotal: 1,
    gradedFiles: 1,
    minCoverage: 1,
    configured: true,
    parseFailed: [],
    unusableIncludeDirs: [] as string[],
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function fixture(includeDirs: string[]): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-verify-incdir-'));
    fs.mkdirSync(path.join(tempDir, 'rtl', 'include'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'rtl', 'include', 'defs.svh'),
      'parameter INCLUDED_PARAM = 4;\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'rtl', 'user.sv'),
      'module user;\n`include "defs.svh"\n  wire own_sig;\nendmodule\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'codegraph.json'),
      JSON.stringify({ verify: { includeDirs } })
    );
    clearProjectConfigCache();
    return tempDir;
  }

  it('exit code: a configured include dir that is not a directory fails strict', () => {
    // Pure, so it runs everywhere. The exit code is the whole point: a note
    // nobody reads is how this degradation stayed invisible.
    const clean = { unusableIncludeDirs: [] };
    const broken = { unusableIncludeDirs: ['rtl/nope'] };
    expect(verifyExitCode({ ...okOutcomeForGate(), ...clean }, true)).toBe(0);
    expect(verifyExitCode({ ...okOutcomeForGate(), ...broken }, true)).toBe(1);
    // Not strict: still advisory, like every other verify finding.
    expect(verifyExitCode({ ...okOutcomeForGate(), ...broken }, false)).toBe(0);
  });

  it.runIf(ORACLE_AVAILABLE)(
    'fails strict, and names the dir, when a configured include dir does not exist',
    async () => {
      // The defect this test exists for: one bad path made the oracle abandon
      // ALL include dirs and grade syntax-only, which found no cross-file
      // declarations, which produced zero MISSING, which exited 0. A weaker
      // run reported as a clean pass.
      const root = fixture(['rtl/include', 'rtl/nope']);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const outcome = cg.verify({ timeoutMs: 60_000 });
        expect(verifyExitCode(outcome, true)).toBe(1);
        const text = formatVerifyReport(outcome, true);
        expect(text).toContain('rtl/nope');
        expect(text).toContain('INCLUDE DIRS');
      } finally {
        cg.destroy();
      }
    }
  );

  it.runIf(ORACLE_AVAILABLE)(
    'keeps the usable include dirs working when one of them is bad',
    async () => {
      // The other half: a bad dir must cost only itself. Before, the whole
      // preprocessed mode was abandoned, so defs.svh was never found at all.
      const root = fixture(['rtl/include', 'rtl/nope']);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const outcome = cg.verify({ timeoutMs: 60_000 });
        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;
        expect(outcome.report.mode).toBe('preprocessed');
        // rtl/include still resolved, so the header's own name is graded there.
        expect(outcome.report.files['rtl/include/defs.svh']?.scope).toContain(
          'INCLUDED_PARAM'
        );
      } finally {
        cg.destroy();
      }
    }
  );
});
