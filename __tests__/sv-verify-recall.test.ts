/**
 * Four recall gaps between the SystemVerilog index and the `codegraph verify`
 * oracle, each pinned by a minimal synthetic reproduction:
 *
 *   1. A begin/end-less `else` whose arm is a two-arm `ifdef/`else/`endif group.
 *      Blanking the directives leaves two statements after `else`; the second
 *      sits in module-item position, error recovery folds the module header into
 *      an ERROR node, and the module itself was never indexed.
 *   2. Struct and union members (typedef'd or anonymous) were never indexed,
 *      while the oracle grades every member declarator.
 *   3. A covergroup's `with function sample(...)` formals were graded as design
 *      scope by the oracle; they are local to the covergroup.
 *   4. A statement-list file (a fragment meant to be `include-d inside a
 *      procedural block) is not a compilation unit: slang and tree-sitter recover
 *      from it differently, so it must be graded loosely and reported as such.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { blankVerilogConditionalDirectives } from '../src/extraction/languages/systemverilog';
import {
  classifyFile,
  formatVerifyReport,
  runGrader,
  verifyExitCode,
} from '../src/verify';
import { clearProjectConfigCache } from '../src/project-config';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** The direct `contains` parent of a node, by name. */
function parentName(r: ReturnType<typeof extractFromSource>, child: Node | undefined): string | undefined {
  if (!child) return undefined;
  const edge = r.edges.find((e) => e.kind === 'contains' && e.target === child.id);
  return edge ? r.nodes.find((n) => n.id === edge.source)?.name : undefined;
}

const ELSE_ARM_IFDEF = [
  'module m(input clk, input r, input [3:0] k, output reg q);', // 1
  'reg [1:0] s;', //                                               2
  'always @(posedge clk)', //                                      3
  '  if (r)', //                                                   4
  '    q <= 1\'b0;', //                                            5
  '  else', //                                                     6
  '`ifdef A', //                                                   7
  "    q <= (k == 4'h9 | k == 4'hb);", //                          8
  '`else', //                                                      9
  "    q <= (k == 4'h9 | k == 4'ha);", //                          10
  '`endif', //                                                     11
  'always @(posedge clk)', //                                      12
  '  if (r) s <= 2\'b0;', //                                       13
  '  else s <= s + 1\'b1;', //                                     14
  'endmodule', //                                                  15
  'module n(input a, output y);', //                               16
  'assign y = ~a;', //                                             17
  'endmodule', //                                                  18
  '',
].join('\n');

describe('cause 1 — a two-arm `ifdef group as the arm of a begin/end-less else', () => {
  it('keeps the module, its signals and the module after it', () => {
    const r = extractFromSource('ifdef_else_arm.v', ELSE_ARM_IFDEF);
    const modules = r.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    expect(modules).toEqual(expect.arrayContaining(['m', 'n']));
    expect(parentName(r, r.nodes.find((n) => n.name === 's'))).toBe('m');
    expect(parentName(r, r.nodes.find((n) => n.name === 'q'))).toBe('m');
    expect(parentName(r, r.nodes.find((n) => n.name === 'y'))).toBe('n');
  });

  it('wraps the group in begin/end, keeping both arms and every byte offset', () => {
    const out = blankVerilogConditionalDirectives(ELSE_ARM_IFDEF);
    expect(out.length).toBe(ELSE_ARM_IFDEF.length);
    const lines = out.split('\n');
    expect(lines[6]?.trim()).toBe('begin');
    expect(lines[8]?.trim()).toBe('');
    expect(lines[10]?.trim()).toBe('end');
    // Both arms survive: the index covers the union of the branches.
    expect(lines[7]).toBe("    q <= (k == 4'h9 | k == 4'hb);");
    expect(lines[9]).toBe("    q <= (k == 4'h9 | k == 4'ha);");
  });

  it('leaves a module-item `ifdef group blanked, never wrapped', () => {
    const src = ['module m;', '`ifdef A', '  wire a;', '`else', '  wire b;', '`endif', 'endmodule', ''].join('\n');
    const out = blankVerilogConditionalDirectives(src);
    expect(out.split('\n').map((l) => l.trim())).toEqual(['module m;', '', 'wire a;', '', 'wire b;', '', 'endmodule', '']);
  });

  it('recovers the module from its header when two bare statements follow else (no directive)', () => {
    // Two recovering modules in a row: the second ERROR node starts with the
    // first module's `endmodule` and carries the second module's header.
    const src = [
      'module m2(input clk, input r, input [3:0] k, output reg q);', // 1
      'always @(posedge clk)', //                                       2
      '  if (r)', //                                                    3
      "    q <= 1'b0;", //                                              4
      '  else', //                                                      5
      "    q <= (k == 4'h1 | k == 4'h3);", //                           6
      "    q <= (k == 4'h2 | k == 4'h3);", //                           7
      'reg z;', //                                                      8
      'endmodule', //                                                   9
      'module m4(input clk, input r, input [3:0] k, output reg p);', // 10
      'always @(posedge clk)', //                                       11
      '  if (r)', //                                                    12
      "    p <= 1'b0;", //                                              13
      '  else', //                                                      14
      "    p <= (k == 4'h1 | k == 4'h3);", //                           15
      "    p <= (k == 4'h2 | k == 4'h3);", //                           16
      'reg z4;', //                                                     17
      'endmodule', //                                                   18
      'module n2(input a, output y);', //                               19
      'wire w2;', //                                                    20
      'assign y = a;', //                                               21
      'endmodule', //                                                   22
      '',
    ].join('\n');
    const r = extractFromSource('two_stmts.v', src);
    const m2 = r.nodes.find((n) => n.kind === 'module' && n.name === 'm2');
    expect(m2).toBeDefined();
    // The recovered module spans to its endmodule, not just the ERROR node.
    expect(m2?.startLine).toBe(1);
    expect(m2?.endLine).toBe(9);
    expect(parentName(r, r.nodes.find((n) => n.name === 'q'))).toBe('m2');
    expect(parentName(r, r.nodes.find((n) => n.name === 'z'))).toBe('m2');
    const m4 = r.nodes.find((n) => n.kind === 'module' && n.name === 'm4');
    expect(m4?.startLine).toBe(10);
    expect(m4?.endLine).toBe(18);
    expect(parentName(r, r.nodes.find((n) => n.name === 'p'))).toBe('m4');
    expect(parentName(r, r.nodes.find((n) => n.name === 'z4'))).toBe('m4');
    expect(r.nodes.some((n) => n.kind === 'module' && n.name === 'n2')).toBe(true);
    expect(parentName(r, r.nodes.find((n) => n.name === 'w2'))).toBe('n2');
  });

  it('recovers the module when the stray statement is the last item before endmodule', () => {
    const src = [
      'module m3(input clk, input r, input [3:0] k, output reg q);',
      'reg [1:0] t;',
      'always @(posedge clk)',
      '  if (r)',
      '    q <= 1\'b0;',
      '  else',
      "    q <= (k == 4'h1 | k == 4'h3);",
      "    q <= (k == 4'h2 | k == 4'h3);",
      'endmodule',
      '',
    ].join('\n');
    const r = extractFromSource('stray_last.v', src);
    expect(r.nodes.some((n) => n.kind === 'module' && n.name === 'm3')).toBe(true);
    expect(parentName(r, r.nodes.find((n) => n.name === 't'))).toBe('m3');
  });
});

describe('cause 2 — struct and union members', () => {
  const src = [
    'package p;',
    '  typedef struct packed {',
    '    logic a;',
    '    logic [1:0] b, c;',
    '  } s_t;',
    '  typedef union packed { logic [3:0] u0; logic [3:0] u1; } u_t;',
    '  typedef enum logic [1:0] { E0, E1 } e_t;',
    'endpackage',
    'module m;',
    '  struct packed { logic d; logic e; } v;',
    '  p::s_t w;',
    'endmodule',
    '',
  ].join('\n');

  it('indexes each typedef struct member under its type', () => {
    const r = extractFromSource('struct_pkg.sv', src);
    const st = r.nodes.find((n) => n.name === 's_t');
    expect(st).toBeDefined();
    for (const name of ['a', 'b', 'c']) {
      const member = r.nodes.find((n) => n.name === name);
      expect(member?.kind, name).toBe('field');
      expect(parentName(r, member), name).toBe('s_t');
    }
    // A member carries its declaration text, so search output reads like SV.
    expect(r.nodes.find((n) => n.name === 'b')?.signature).toContain('logic [1:0] b, c');
  });

  it('indexes typedef union members under their type', () => {
    const r = extractFromSource('struct_pkg.sv', src);
    for (const name of ['u0', 'u1']) {
      expect(parentName(r, r.nodes.find((n) => n.name === name)), name).toBe('u_t');
    }
  });

  it('indexes the members of an anonymous struct variable under the module, beside the variable', () => {
    const r = extractFromSource('struct_pkg.sv', src);
    expect(parentName(r, r.nodes.find((n) => n.name === 'v'))).toBe('m');
    for (const name of ['d', 'e']) {
      expect(parentName(r, r.nodes.find((n) => n.name === name)), name).toBe('m');
    }
    // A package-typed variable is unchanged: one field, no members invented.
    expect(parentName(r, r.nodes.find((n) => n.name === 'w'))).toBe('m');
  });

  it('keeps an enum typedef an enum with its members', () => {
    const r = extractFromSource('struct_pkg.sv', src);
    expect(r.nodes.find((n) => n.name === 'e_t')?.kind).toBe('enum');
    expect(r.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name).sort()).toEqual(['E0', 'E1']);
  });
});

// -- Oracle-backed tests -------------------------------------------------------

const ORACLE_AVAILABLE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oracle-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'p.sv'), 'module p; wire a; endmodule\n');
    return (
      runGrader({ root: dir, files: ['p.sv'], includeDirs: [], defines: {}, timeoutMs: 60_000 }).status === 'ok'
    );
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

const COVERGROUP = [
  'module m;',
  '  logic clk;',
  '  int cnt;',
  '  covergroup cg with function sample(int a, int b, bit c);',
  '    option.per_instance = 1;',
  '    cp_a : coverpoint a { bins lo = {0}; bins hi = {1}; }',
  '    cp_b : coverpoint b;',
  '    x_ab : cross cp_a, cp_b;',
  '  endgroup',
  '  cg cg_i = new();',
  '  covergroup cg_clk @(posedge clk);',
  '    cp_cnt : coverpoint cnt;',
  '  endgroup',
  '  cg_clk cg_clk_i = new();',
  'endmodule',
  '',
].join('\n');

/** A statement list meant to be `include-d inside a procedural block. */
const FRAGMENT_LOOP = [
  'total = 0;',
  'for (i = 0; i < 4; i++) begin',
  '    for (j = 0; j < 2; j++) begin',
  '        bit src, snk;',
  '        src = (i == j);',
  '        snk = (i != j);',
  '        if (src || snk) tbl[j][i] = snk;',
  '    end',
  'end',
  'apply(tbl);',
  '',
].join('\n');

const FRAGMENT_FORK = [
  'drive(x, 1\'b1);',
  '#(SETTLE);',
  'fork',
  '    begin',
  '        logic prev, cur;',
  '        prev = probe(x);',
  '        forever begin',
  '            @(pad);',
  '            cur = probe(x);',
  '            if (cur !== prev) $display("%b -> %b", prev, cur);',
  '            prev = cur;',
  '        end',
  '    end',
  'join_none',
  '#(TAIL);',
  '',
].join('\n');

/** Module items meant to be `include-d inside a module: still graded strictly. */
const ITEM_HEADER = ['parameter P = 4;', 'wire w;', 'logic [3:0] v;', 'assign w = 1\'b0;', ''].join('\n');

describe('oracle-backed — covergroup formals and statement fragments', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    clearProjectConfigCache();
  });

  function write(files: Record<string, string>): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-recall-'));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tempDir, rel), text);
    }
    return tempDir;
  }

  it.runIf(ORACLE_AVAILABLE)('cause 3: grades the sample() formals of a covergroup as local, not design scope', () => {
    const root = write({ 'cg.sv': COVERGROUP });
    const outcome = runGrader({ root, files: ['cg.sv'], includeDirs: [], defines: {}, timeoutMs: 60_000 });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const graded = outcome.report.files['cg.sv'];
    for (const name of ['a', 'b', 'c']) {
      expect(graded?.scope, name).not.toContain(name);
      expect(graded?.local, name).toContain(name);
    }
    // The instances and the module's own signals stay design scope.
    expect(graded?.scope).toEqual(expect.arrayContaining(['m', 'clk', 'cnt', 'cg_i', 'cg_clk_i']));
  });

  it.runIf(ORACLE_AVAILABLE)('cause 4: marks a statement-list file as a fragment, and an item header not', () => {
    const root = write({ 'frag_loop.sv': FRAGMENT_LOOP, 'frag_fork.sv': FRAGMENT_FORK, 'items.svh': ITEM_HEADER });
    const outcome = runGrader({
      root,
      files: ['frag_loop.sv', 'frag_fork.sv', 'items.svh'],
      includeDirs: [],
      defines: {},
      timeoutMs: 60_000,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const files = outcome.report.files;
    expect(files['frag_loop.sv']?.fragment).toBe(true);
    expect(files['frag_fork.sv']?.fragment).toBe(true);
    // A fragment owns no design-scope name: its declarations live in the block
    // it is included into.
    expect(files['frag_loop.sv']?.scope).toEqual([]);
    expect(files['frag_loop.sv']?.local).toEqual(expect.arrayContaining(['src', 'snk']));
    expect(files['frag_fork.sv']?.local).toEqual(expect.arrayContaining(['prev', 'cur']));
    // Module items read as members, not statements: graded strictly.
    expect(files['items.svh']?.fragment).toBeFalsy();
    expect(files['items.svh']?.scope).toEqual(expect.arrayContaining(['P', 'w', 'v']));
  });

  it.runIf(ORACLE_AVAILABLE)('all four: a project of the four shapes verifies strict with 0 MISSING and 0 UNEXPLAINED', async () => {
    const root = write({
      'ifdef_else_arm.v': ELSE_ARM_IFDEF,
      'struct_pkg.sv': [
        'package p;',
        '  typedef struct packed { logic a; logic [1:0] b, c; } s_t;',
        '  typedef union packed { logic [3:0] u0; logic [3:0] u1; } u_t;',
        'endpackage',
        'module ms;',
        '  struct packed { logic d; logic e; } v;',
        'endmodule',
        '',
      ].join('\n'),
      'cg.sv': COVERGROUP,
      'frag_loop.sv': FRAGMENT_LOOP,
      'frag_fork.sv': FRAGMENT_FORK,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const outcome = cg.verify({ timeoutMs: 60_000 });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      const bad = outcome.result.files
        .flatMap((f) => f.disagreements)
        .filter((d) => d.verdict !== 'BRANCH-UNION')
        .map((d) => `${d.verdict} ${d.file} ${d.name}`)
        .sort();
      expect(bad).toEqual([]);
      expect(outcome.result.missing).toBe(0);
      expect(outcome.result.unexplained).toBe(0);
      expect(verifyExitCode(outcome, true)).toBe(0);
      // The loosening is visible in the report, by file.
      const text = formatVerifyReport(outcome, true);
      expect(text).toContain('FRAGMENTS     2');
      expect(text).toContain('frag_loop.sv');
      expect(text).toContain('frag_fork.sv');
    } finally {
      cg.destroy();
    }
  });
});

describe('cause 4 — the classifier grades a fragment loosely', () => {
  it('reports no MISSING and no UNEXPLAINED for a file the oracle marked a fragment', () => {
    const verdict = classifyFile(
      'frag.sv',
      { scope: ['only_in_oracle'], local: [], fragment: true },
      new Map([['only_in_index', 3]]),
      []
    );
    expect(verdict.disagreements).toEqual([]);
    expect(verdict.graded).toBe(0);
  });

  it('still grades a file without the fragment mark strictly', () => {
    const verdict = classifyFile('m.sv', { scope: ['only_in_oracle'], local: [] }, new Map([['only_in_index', 3]]), []);
    expect(verdict.disagreements.map((d) => d.verdict).sort()).toEqual(['MISSING', 'UNEXPLAINED']);
  });
});
