/**
 * SystemVerilog / Verilog extraction tests.
 *
 * Locks in the design-hierarchy mapping (module/instantiation), subroutine-body
 * call capture, enum-member emission, and package/import handling.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { matchReference } from '../src/resolution/name-matcher';
import { blankVerilogConditionalDirectives } from '../src/extraction/languages/systemverilog';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('SystemVerilog language detection', () => {
  it('maps the HDL extensions to systemverilog', () => {
    expect(detectLanguage('rtl/fifo.sv')).toBe('systemverilog');
    expect(detectLanguage('pkg/types.svh')).toBe('systemverilog');
    expect(detectLanguage('legacy/core.v')).toBe('systemverilog');
    expect(detectLanguage('inc/defs.vh')).toBe('systemverilog');
  });
});

describe('SystemVerilog extraction', () => {
  it('emits module nodes and instantiation edges (instantiates + calls) to the module type', () => {
    const code = `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z);
  leaf u_leaf(.a(x), .y(z));
endmodule
`;
    const r = extractFromSource('top.sv', code);
    const modules = r.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    expect(modules).toEqual(expect.arrayContaining(['leaf', 'top']));

    // The instantiation binds to the module TYPE (leaf), not the u_leaf label.
    const refs = r.unresolvedReferences.filter((x) => x.referenceName === 'leaf');
    expect(refs.some((x) => x.referenceKind === 'instantiates')).toBe(true);
    expect(refs.some((x) => x.referenceKind === 'calls')).toBe(true);
    expect(refs.some((x) => x.referenceName === 'u_leaf')).toBe(false);
  });

  it('captures calls made inside subroutine (function/task) bodies', () => {
    const code = `
module m;
  function automatic int g(input int v);
    return v;
  endfunction
  task automatic f(input int v);
    int t;
    t = g(v);
  endtask
endmodule
`;
    const r = extractFromSource('m.sv', code);
    const calls = r.unresolvedReferences.filter(
      (x) => x.referenceKind === 'calls' && x.referenceName === 'g'
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('emits enum members for typedef enums', () => {
    const code = `
package p;
  typedef enum logic [1:0] { A, B, C } e_t;
endpackage
`;
    const r = extractFromSource('p.sv', code);
    expect(r.nodes.some((n) => n.kind === 'enum' && n.name === 'e_t')).toBe(true);
    const members = r.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name);
    expect(members).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });

  it('maps package to a namespace node and package-import to an import node', () => {
    const code = `
package pkg;
  localparam int W = 8;
endpackage
import pkg::*;
module m(input logic clk);
endmodule
`;
    const r = extractFromSource('m.sv', code);
    expect(r.nodes.some((n) => n.kind === 'namespace' && n.name === 'pkg')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'import' && n.name === 'pkg')).toBe(true);
  });

  it('maps a scalar typedef to a type_alias node (engine path, not the hook)', () => {
    const code = `
package p;
  typedef logic [7:0] byte_t;
endpackage
`;
    const r = extractFromSource('p.sv', code);
    expect(r.nodes.some((n) => n.kind === 'type_alias' && n.name === 'byte_t')).toBe(true);
  });

  it('emits one import per package in a comma-separated import statement', () => {
    const code = `
package a; localparam int X = 1; endpackage
package b; localparam int Y = 2; endpackage
import a::*, b::Y;
module m(input logic clk);
endmodule
`;
    const r = extractFromSource('m.sv', code);
    const imports = r.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('parses real-world RTL without errors (non-ANSI ports, generate)', () => {
    const code = `
module leaf_na(o, i);
  output o;
  input  i;
  assign o = ~i;
endmodule
module gen_top #(parameter int N = 4) (input [3:0] x, output [3:0] y);
  genvar gi;
  generate
    for (gi = 0; gi < N; gi++) begin : g_loop
      leaf_na u (.o(y[gi]), .i(x[gi]));
    end
  endgenerate
endmodule
`;
    const r = extractFromSource('gen.sv', code);
    const modules = r.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    expect(modules).toEqual(expect.arrayContaining(['leaf_na', 'gen_top']));
    // instantiation inside a generate-for is still attributed to the enclosing module
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'instantiates' && x.referenceName === 'leaf_na'
      )
    ).toBe(true);
  });

  it('captures UVM class inheritance, the new constructor, and class-vs-module method scoping', () => {
    const code = `
class base_driver extends uvm_driver #(my_txn);
  function new(string name);
    super.new(name);
  endfunction
  virtual function void build_phase(uvm_phase phase);
    configure();
  endfunction
  function void configure();
  endfunction
endclass
module m;
  function int helper(input int v);
    return v;
  endfunction
endmodule
`;
    const r = extractFromSource('uvm.sv', code);

    // The extends clause binds to the base class (the `#(my_txn)` params are ignored).
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'extends' && x.referenceName === 'uvm_driver'
      )
    ).toBe(true);

    // `function new` is captured as a method named 'new'.
    expect(r.nodes.some((n) => n.kind === 'method' && n.name === 'new')).toBe(true);

    // Class subroutines read as methods ...
    const methods = r.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methods).toEqual(expect.arrayContaining(['new', 'build_phase', 'configure']));

    // ... while a module-level subroutine stays a function (not mislabeled a method).
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'helper')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'method' && n.name === 'helper')).toBe(false);
  });

  it('still resolves calls made inside a class method body (method dispatch keeps body walk)', () => {
    const code = `
class c;
  virtual function void build_phase();
    configure();
  endfunction
  function void configure();
  endfunction
endclass
`;
    const r = extractFromSource('c.sv', code);
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'calls' && x.referenceName === 'configure'
      )
    ).toBe(true);
  });

  it('binds a package-qualified extends to the base class, not the package scope', () => {
    const code = `
package uvm_pkg;
  class uvm_driver #(type T = int);
  endclass
endpackage
class d extends uvm_pkg::uvm_driver #(my_txn);
endclass
`;
    const r = extractFromSource('d.sv', code);
    const ext = r.unresolvedReferences.filter((x) => x.referenceKind === 'extends');
    // the qualifier is preserved (so the resolver can disambiguate by package) and
    // the package is NOT mistaken for the base class
    expect(ext.some((x) => x.referenceName === 'uvm_pkg::uvm_driver')).toBe(true);
    expect(ext.some((x) => x.referenceName === 'uvm_pkg')).toBe(false);
  });

  it('resolves a package-qualified extends to the matching package class under a name collision', () => {
    const mk = (id: string, qualifiedName: string, filePath: string): Node =>
      ({
        id, name: 'Base', kind: 'class', qualifiedName, filePath,
        language: 'systemverilog', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      } as Node);
    const p1Base = mk('P1', 'p1::Base', 'pkg1/p1.sv');
    const p2Base = mk('P2', 'p2::Base', 'pkg2/p2.sv');
    const ctx = {
      getNodesByName: (n: string) => (n === 'Base' ? [p1Base, p2Base] : []),
      getNodesByQualifiedName: (q: string) =>
        [p1Base, p2Base].filter((n) => n.qualifiedName === q),
      getNodesByKind: () => [],
      getNodesInFile: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    } as unknown as ResolutionContext;
    const ref: UnresolvedRef = {
      fromNodeId: 'D', referenceName: 'p2::Base', referenceKind: 'extends',
      line: 6, column: 0, filePath: 'tb/d.sv', language: 'systemverilog',
    };
    // bare "Base" would tie-break on proximity and could pick p1; the scoped name resolves p2.
    expect(matchReference(ref, ctx)?.targetNodeId).toBe('P2');
  });

  it('extracts out-of-class method/constructor definitions as methods, not loose functions', () => {
    const code = `
class d;
  extern function void cfg();
  extern function new(string name);
endclass
function void d::cfg();
endfunction
function d::new(string name);
endfunction
module m;
  function int helper();
    return 0;
  endfunction
endmodule
`;
    const r = extractFromSource('d.sv', code);
    const methods = r.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    // out-of-class `d::cfg` / `d::new` are methods of class d (receiver path)
    expect(methods).toEqual(expect.arrayContaining(['cfg', 'new']));
    // the module subroutine stays a plain function ...
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'helper')).toBe(true);
    // ... and the out-of-class defs are NOT also emitted as loose functions
    expect(r.nodes.some((n) => n.kind === 'function' && (n.name === 'cfg' || n.name === 'new'))).toBe(false);
  });

  it('resolves an extends reference to a class over a same-named function (resolver kind bias)', () => {
    const mk = (id: string, kind: Node['kind'], filePath: string): Node =>
      ({
        id, name: 'base_c', kind, qualifiedName: 'base_c', filePath,
        language: 'systemverilog', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      } as Node);
    const klass = mk('CLASS', 'class', 'pkg/base.sv');
    const fn = mk('FUNC', 'function', 'rtl/util.sv');
    // function listed FIRST: only the extends kind-bias (not iteration order) can make the class win.
    const ctx = {
      getNodesByName: (n: string) => (n === 'base_c' ? [fn, klass] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesInFile: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    } as unknown as ResolutionContext;
    const ref: UnresolvedRef = {
      fromNodeId: 'D', referenceName: 'base_c', referenceKind: 'extends',
      line: 5, column: 0, filePath: 'tb/d.sv', language: 'systemverilog',
    };
    expect(matchReference(ref, ctx)?.targetNodeId).toBe('CLASS');
  });
});

/**
 * Inheritance-aware `this.`/`super.` call resolution, end-to-end.
 *
 * These index a real on-disk fixture and assert the resolved `calls` EDGES
 * (not extraction-time refs). The load-bearing case is `super.m()` binding to
 * the PARENT's `m` rather than the caller's own — the self-edge trap.
 */
describe('SystemVerilog this./super. call resolution', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Index `code` as a single .sv file and run resolution end-to-end.
  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-resolve-'));
    fs.writeFileSync(path.join(tempDir, 'dut.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  // The method node for `className::methodName` (qualified-name match avoids
  // colliding with a same-named method on another class).
  function method(graph: CodeGraph, className: string, methodName: string): Node {
    const hit = graph
      .getNodesByKind('method')
      .find((n) => n.name === methodName && n.qualifiedName.includes(className));
    expect(hit, `method ${className}::${methodName}`).toBeDefined();
    return hit!;
  }

  function callTargets(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => e.target);
  }

  it('binds super.m() to the parent class method, not the caller’s own', async () => {
    cg = await indexSv(`
class Base;
  virtual function void m();
  endfunction
endclass
class Derived extends Base;
  virtual function void m();
    super.m();
    this.helper();
  endfunction
  function void helper();
  endfunction
endclass
`);
    const derivedM = method(cg, 'Derived', 'm');
    const baseM = method(cg, 'Base', 'm');
    const derivedHelper = method(cg, 'Derived', 'helper');

    const targets = callTargets(cg, derivedM);

    // super.m() resolves to Base::m ...
    expect(targets).toContain(baseM.id);
    // ... and this.helper() to the enclosing class's helper ...
    expect(targets).toContain(derivedHelper.id);
    // ... but there is NO self-edge Derived::m -> Derived::m.
    expect(targets).not.toContain(derivedM.id);
  });

  it('resolves super.m() across a multi-level chain when the parent lacks m', async () => {
    cg = await indexSv(`
class Base;
  virtual function void m();
  endfunction
endclass
class Derived extends Base;
  virtual function void m();
  endfunction
endclass
class Derived2 extends Derived;
  virtual function void run();
    super.m();
  endfunction
endclass
`);
    const run = method(cg, 'Derived2', 'run');
    const derivedM = method(cg, 'Derived', 'm');
    const baseM = method(cg, 'Base', 'm');

    const targets = callTargets(cg, run);

    // Derived2 has no m; super starts at Derived and finds Derived::m first —
    // the nearest override wins, so it must NOT skip past to Base::m.
    expect(targets).toContain(derivedM.id);
    expect(targets).not.toContain(baseM.id);
  });

  it('resolves this.m() up the extends chain to an inherited method', async () => {
    cg = await indexSv(`
class Base;
  virtual function void shared();
  endfunction
endclass
class Derived extends Base;
  virtual function void go();
    this.shared();
  endfunction
endclass
`);
    const go = method(cg, 'Derived', 'go');
    const baseShared = method(cg, 'Base', 'shared');

    // Derived doesn't declare shared(); this. walks up to Base::shared.
    expect(callTargets(cg, go)).toContain(baseShared.id);
  });

  // Count this./super. rows still sitting in unresolved_refs after resolution.
  // Reads the on-disk db directly (the public API exposes resolved edges, not
  // the residual ref table) and closes its own connection so teardown's
  // destroy() doesn't trip a Windows file lock.
  function lingeringHandleRefs(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const rows = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_kind = 'calls'`
      ).all() as Array<{ reference_name: string }>;
      return rows.filter((r) => /^(this|super)\.\w+$/.test(r.reference_name)).length;
    } finally {
      db.close();
    }
  }

  it('drops an unresolvable super.x() (base not indexed): no edge, no lingering ref', async () => {
    // `undefined_base` is referenced but never defined here, so super.run() has
    // no target. The pass must emit no calls edge AND not leave the ref behind
    // to be re-walked on every future sync.
    cg = await indexSv(`
class only_child extends undefined_base;
  virtual function void run();
    super.run();
  endfunction
endclass
`);
    const run = method(cg, 'only_child', 'run');
    // No spurious calls edge from the unresolvable super.run().
    expect(callTargets(cg, run)).toHaveLength(0);
    // And the ref is gone — resolved-or-dropped, never perpetually pending.
    expect(lingeringHandleRefs()).toBe(0);
  });

  it('terminates on a cyclic extends chain without spurious edges', async () => {
    // A <-> B mutual inheritance is illegal SV, but a malformed index must not
    // hang the resolver. The visited-guard breaks the cycle; m() exists nowhere
    // in the (broken) chain, so super.m() binds to nothing.
    cg = await indexSv(`
class A extends B;
  virtual function void go();
    super.m();
  endfunction
endclass
class B extends A;
endclass
`);
    const go = method(cg, 'A', 'go');
    expect(callTargets(cg, go)).toHaveLength(0);
    expect(lingeringHandleRefs()).toBe(0);
  });
});

/**
 * Class-composition (`has-a`) edges, end-to-end. A class field of a user-class
 * type yields a `references` edge class->field-type, giving the UVM testbench
 * topology (test has-an env, env has-an agent, ...). Builtin-typed and
 * self-typed fields produce no edge.
 */
describe('SystemVerilog class-composition (has-a) edges', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-compose-'));
    fs.writeFileSync(path.join(tempDir, 'tb.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function classNode(graph: CodeGraph, name: string): Node {
    const hit = graph.getNodesByKind('class').find((n) => n.name === name);
    expect(hit, `class ${name}`).toBeDefined();
    return hit!;
  }

  // Qualified-name strings of every `references`-edge target from a class.
  function refTargets(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)?.qualifiedName ?? e.target);
  }

  // `references` rows still pending in unresolved_refs (used to prove a builtin
  // field left nothing behind). Closes its own db connection for clean teardown.
  function lingeringRefs(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const row = db.getDb().prepare(
        `SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_kind = 'references'`
      ).get() as { c: number };
      return row.c;
    } finally {
      db.close();
    }
  }

  it('emits a class->field-type references edge (deduped across multiple fields)', async () => {
    cg = await indexSv(`
class Sub;
endclass
class Top;
  Sub a;
  Sub b;
endclass
`);
    const top = classNode(cg, 'Top');
    const sub = classNode(cg, 'Sub');
    expect(cg.getOutgoingEdges(top.id).some((e) => e.kind === 'references' && e.target === sub.id)).toBe(true);
  });

  it('does not emit a self-reference for a self-typed field', async () => {
    cg = await indexSv(`
class Node1;
  Node1 nxt;
endclass
`);
    const node1 = classNode(cg, 'Node1');
    // A class pointing at itself is noise in a has-a graph — must be dropped.
    expect(cg.getOutgoingEdges(node1.id).some((e) => e.kind === 'references' && e.target === node1.id)).toBe(false);
  });

  it('ignores builtin-typed fields: no edge, no lingering reference', async () => {
    cg = await indexSv(`
class HasPrimitives;
  int count;
  string name;
endclass
`);
    const c = classNode(cg, 'HasPrimitives');
    expect(refTargets(cg, c)).toHaveLength(0);
    // int/string never become a ref at all, so nothing lingers unresolved.
    expect(lingeringRefs()).toBe(0);
  });

  it('binds a package-qualified field type to the scoped class', async () => {
    cg = await indexSv(`
package pkg;
  class Base;
  endclass
endpackage
class Holder;
  pkg::Base h;
endclass
`);
    const holder = classNode(cg, 'Holder');
    // The qualifier is preserved so the resolver lands on pkg::Base specifically.
    expect(refTargets(cg, holder)).toContain('pkg::Base');
  });

  it('emits an edge for fields behind property qualifiers (rand/local/protected/const)', async () => {
    // UVM fields are overwhelmingly `rand <txn>` / `local`/`protected <comp>`.
    // Most qualifiers parse as a sibling node before the data_declaration; a
    // `const` member instead exposes data_type directly (no data_declaration
    // wrapper). The type extractor must handle both. Distinct types per
    // qualifier ensure a miss can't be masked by dedup against the plain field.
    cg = await indexSv(`
class qa; endclass
class qb; endclass
class qc; endclass
class qd; endclass
class qe; endclass
class qf; endclass
class holder;
  qa plain_h;
  rand qb rand_h;
  local qc local_h;
  protected qd prot_h;
  rand local qe rl_h;
  const qf const_h;
endclass
`);
    const holder = classNode(cg, 'holder');
    const targets = refTargets(cg, holder);
    for (const ty of ['qa', 'qb', 'qc', 'qd', 'qe', 'qf']) {
      expect(targets, `holder should reference ${ty}`).toContain(ty);
    }
  });
});

/**
 * UVM factory-create composition + TLM-connect dataflow, end-to-end. A
 * `h = T::type_id::create(...)` yields a class->T `references` edge and feeds a
 * per-class handle->component map; an `a.b.connect(c.d)` resolves both dotted
 * chains through that map and emits a component->component dataflow edge.
 */
describe('SystemVerilog factory-create + TLM-connect (dataflow)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-tlm-'));
    fs.writeFileSync(path.join(tempDir, 'tb.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function classNode(graph: CodeGraph, name: string): Node {
    const hit = graph.getNodesByKind('class').find((n) => n.name === name);
    expect(hit, `class ${name}`).toBeDefined();
    return hit!;
  }

  function refTargetNames(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)?.name ?? e.target);
  }

  // Any `__sv_*__` marker still pending after resolution (must be zero).
  function lingeringMarkers(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const row = db.getDb().prepare(
        `SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name LIKE '__sv\\_%' ESCAPE '\\'`
      ).get() as { c: number };
      return row.c;
    } finally {
      db.close();
    }
  }

  it('emits a class->type edge for a factory create', async () => {
    cg = await indexSv(`
class Sub; endclass
class Top;
  Sub h;
  function void build_phase();
    h = Sub::type_id::create("h", this);
  endfunction
endclass
`);
    const top = classNode(cg, 'Top');
    expect(refTargetNames(cg, top)).toContain('Sub');
    expect(lingeringMarkers()).toBe(0);
  });

  it('captures a factory override: a base-typed handle created as a derived type', async () => {
    cg = await indexSv(`
class base_drv; endclass
class deriv_drv extends base_drv; endclass
class agent_c;
  base_drv drv;
  function void build_phase();
    drv = deriv_drv::type_id::create("drv", this);
  endfunction
endclass
`);
    const agent = classNode(cg, 'agent_c');
    // The create binds the DERIVED type even though the handle is base-typed —
    // the factory-override win that a field-only view would miss.
    expect(refTargetNames(cg, agent)).toContain('deriv_drv');
  });

  it('resolves a TLM connect chain to a component->component dataflow edge', async () => {
    cg = await indexSv(`
class M;
  int ap;
endclass
class B;
  int export_h;
endclass
class A;
  M m;
  function void build_phase();
    m = M::type_id::create("m", this);
  endfunction
endclass
class env_c;
  A a;
  B b;
  function void build_phase();
    a = A::type_id::create("a", this);
    b = B::type_id::create("b", this);
  endfunction
  function void connect_phase();
    a.m.ap.connect(b.export_h);
  endfunction
endclass
`);
    const m = classNode(cg, 'M');
    const b = classNode(cg, 'B');
    // a -> A, A.m -> M (chain), `ap` is a port (not created) so the walk stops
    // at M; the arg chain stops at B. Dataflow edge M -> B.
    expect(cg.getOutgoingEdges(m.id).some((e) => e.kind === 'references' && e.target === b.id)).toBe(true);
    // The port token must NOT produce an edge to a non-component.
    expect(refTargetNames(cg, m)).not.toContain('A');
    expect(lingeringMarkers()).toBe(0);
  });

  it('drops a connect whose handles do not resolve: no edge, no lingering marker', async () => {
    cg = await indexSv(`
class lonely;
  function void connect_phase();
    foo.bar.connect(baz.qux);   // no creates anywhere -> chains resolve to nothing
  endfunction
endclass
`);
    const lonely = classNode(cg, 'lonely');
    expect(refTargetNames(cg, lonely)).toHaveLength(0);
    // The unresolvable connect marker must not linger to be re-walked each sync.
    expect(lingeringMarkers()).toBe(0);
  });

  it('handles a `__`-bearing handle in a factory override (marker split is `|`, not `__`)', async () => {
    // `my__h` is a legal SV name; a `__`-delimited marker would split the body
    // mid-identifier and silently drop the override edge.
    cg = await indexSv(`
class base_t; endclass
class deriv_t extends base_t; endclass
class Holder;
  base_t my__h;
  function void build_phase();
    my__h = deriv_t::type_id::create("h", this);
  endfunction
endclass
`);
    const holder = classNode(cg, 'Holder');
    // The factory-override edge to the DERIVED type must survive.
    expect(refTargetNames(cg, holder)).toContain('deriv_t');
    expect(lingeringMarkers()).toBe(0);
  });

  it('resolves a TLM connect that hops through a `__`-bearing handle', async () => {
    cg = await indexSv(`
class M;
  int ap;
endclass
class B;
  int export_h;
endclass
class A;
  M sub__mon;
  function void build_phase();
    sub__mon = M::type_id::create("sub__mon", this);
  endfunction
endclass
class env_c;
  A a__inst;
  B b;
  function void build_phase();
    a__inst = A::type_id::create("a__inst", this);
    b       = B::type_id::create("b", this);
  endfunction
  function void connect_phase();
    a__inst.sub__mon.ap.connect(b.export_h);
  endfunction
endclass
`);
    const m = classNode(cg, 'M');
    const b = classNode(cg, 'B');
    // Chain a__inst -> A, A.sub__mon -> M, port `ap` stops -> dataflow M -> B.
    expect(cg.getOutgoingEdges(m.id).some((e) => e.kind === 'references' && e.target === b.id)).toBe(true);
    expect(lingeringMarkers()).toBe(0);
  });

  it('does not duplicate the field edge: a declared+created type yields exactly one row', async () => {
    cg = await indexSv(`
class Comp; endclass
class Owner;
  Comp c;
  function void build_phase();
    c = Comp::type_id::create("c", this);
  endfunction
endclass
`);
    const owner = classNode(cg, 'Owner');
    const comp = classNode(cg, 'Comp');
    // Field decl + factory create of the SAME type → ONE references row, not two
    // (the create edge is suppressed because the field edge already covers it).
    const toComp = cg
      .getOutgoingEdges(owner.id)
      .filter((e) => e.kind === 'references' && e.target === comp.id);
    expect(toComp).toHaveLength(1);
  });
});

describe('SystemVerilog signal extraction (ports, nets, variables, parameters)', () => {
  /** kind:name[decorators]@line for every signal-ish node, in extraction order. */
  const sigs = (code: string, file = 'sig.sv') =>
    extractFromSource(file, code)
      .nodes.filter((n) => n.kind === 'field' || n.kind === 'constant')
      .map((n) => `${n.kind}:${n.name}[${(n.decorators ?? []).join(',')}]@${n.startLine}`);

  it('extracts ANSI ports with their direction, including direction-inheriting ports', () => {
    // `rstn` carries NO header of its own — it inherits `input` from `clk`.
    // Anchoring on the header child instead of the port_name field drops it.
    const code = `
module top (
  input logic clk, rstn,
  output reg [7:0] q,
  inout wire sda
);
endmodule
`;
    expect(sigs(code)).toEqual([
      'field:clk[input]@3',
      'field:rstn[input]@3',
      'field:q[output]@4',
      'field:sda[inout]@5',
    ]);
  });

  it('extracts non-ANSI port declarations across all three identifier-list shapes', () => {
    // `input a, b;` -> list_of_port_identifiers, `output reg y;` ->
    // list_of_variable_port_identifiers. Both must be accepted.
    const code = `
module leaf_na(a, b, y, oe);
  input a, b;
  output reg y;
  inout oe;
endmodule
`;
    expect(sigs(code, 'leaf_na.v')).toEqual([
      'field:a[input]@3',
      'field:b[input]@3',
      'field:y[output]@4',
      'field:oe[inout]@5',
    ]);
  });

  it('extracts nets and variables, keeping every declarator of a multi-declarator line', () => {
    // `reg`/`logic`/`bit` are data_declaration, NOT net_declaration — treating
    // them as nets extracts nothing.
    const code = `
module m;
  wire [3:0] cnt, cnt2;
  reg valid;
  logic [31:0] data_q;
  bit flag;
endmodule
`;
    expect(sigs(code)).toEqual([
      'field:cnt[wire]@3',
      'field:cnt2[wire]@3',
      'field:valid[reg]@4',
      'field:data_q[logic]@5',
      'field:flag[bit]@6',
    ]);
  });

  it('extracts parameters and localparams from both the #() port list and the body', () => {
    // localparam is local_parameter_declaration, a DIFFERENT node type — a
    // query on parameter_declaration alone misses every one of them.
    const code = `
module p #(parameter int W = 8, localparam DEPTH = 16) ();
  localparam MAGIC = 32'hDEAD;
  parameter LATE = 3;
endmodule
`;
    expect(sigs(code)).toEqual([
      'constant:W[parameter]@2',
      'constant:DEPTH[localparam]@2',
      'constant:MAGIC[localparam]@3',
      'constant:LATE[parameter]@4',
    ]);
  });

  it('does not double-extract a typedef as a field (type_declaration is a data_declaration)', () => {
    const code = `
module m;
  typedef logic [7:0] byte_t;
  byte_t b0;
endmodule
`;
    const r = extractFromSource('td.sv', code);
    expect(r.nodes.filter((n) => n.kind === 'type_alias').map((n) => n.name)).toEqual(['byte_t']);
    expect(r.nodes.filter((n) => n.kind === 'field').map((n) => n.name)).toEqual(['b0']);
  });

  it('nests signals under their module (contains edge + qualified name)', () => {
    const code = `
module a;
  wire w_a;
endmodule
module b;
  wire w_b;
endmodule
`;
    const r = extractFromSource('two.sv', code);
    const wa = r.nodes.find((n) => n.name === 'w_a');
    const wb = r.nodes.find((n) => n.name === 'w_b');
    expect(wa?.qualifiedName).toContain('a');
    expect(wb?.qualifiedName).toContain('b');
    expect(wa?.qualifiedName).not.toBe(wb?.qualifiedName);
  });

  it('carries the declaration text as the signature', () => {
    const code = `
module m(rx_wdata_l);
  output [23:00] rx_wdata_l;
endmodule
`;
    const r = extractFromSource('sig2.v', code);
    expect(r.nodes.find((n) => n.name === 'rx_wdata_l')?.signature).toBe(
      'output [23:00] rx_wdata_l'
    );
  });
});

describe('SystemVerilog `ifdef handling (preParse directive blanking)', () => {
  it('indexes BOTH branches of an `ifdef and keeps line numbers exact', () => {
    // A common ASIC-project shape: an FPGA build uses a continuous
    // assign, the ASIC build instantiates a cell. Both are facts about the
    // design, and the grammar has no preprocessor to pick between them.
    const code = `
module clk_sel(input a, output y);
\`ifdef FPGA
  assign y = a;
  wire fpga_only;
\`else
  BUFF u_buf(.A(a), .Z(y));
  wire asic_only;
\`endif
endmodule
`;
    const r = extractFromSource('clk_sel.v', code);
    const fields = r.nodes.filter((n) => n.kind === 'field');
    // Both branches present, at their ORIGINAL line numbers.
    expect(fields.find((n) => n.name === 'fpga_only')?.startLine).toBe(5);
    expect(fields.find((n) => n.name === 'asic_only')?.startLine).toBe(8);
    // The module still spans the whole file — no ERROR node truncated it.
    const mod = r.nodes.find((n) => n.kind === 'module' && n.name === 'clk_sel');
    expect(mod?.startLine).toBe(2);
    expect(mod?.endLine).toBe(10);
    // The guarded instantiation still binds.
    expect(
      r.unresolvedReferences.some((x) => x.referenceName === 'BUFF' && x.referenceKind === 'instantiates')
    ).toBe(true);
  });

  it('blanks directive lines in place: same length, same line count, offsets preserved', () => {
    const src = '`ifdef A\nwire x;\n  `endif\n';
    const out = blankVerilogConditionalDirectives(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toBe('        \nwire x;\n        \n');
  });

  it('leaves `define, `include and `timescale alone', () => {
    const src = '`timescale 1ns/1ps\n`define W 8\n`include "defs.svh"\n';
    expect(blankVerilogConditionalDirectives(src)).toBe(src);
  });

  it('is a no-op on a file with no backtick at all', () => {
    const src = 'module m;\nendmodule\n';
    expect(blankVerilogConditionalDirectives(src)).toBe(src);
  });
});

describe('SystemVerilog driver edges (what writes this net)', () => {
  /** name@line for every drive marker the extractor emits. */
  const drives = (code: string, file = 'drv.v') =>
    extractFromSource(file, code)
      .unresolvedReferences.filter((r) => r.referenceKind === 'drives')
      .map((r) => `${r.referenceName.replace('__sv_drive__', '')}@${r.line}`);

  it('captures all four writer shapes', () => {
    const code = `
module core(input clk, input a, input b, output reg [3:0] q, output y);
  wire [3:0] cnt;
  reg  [3:0] nxt;
  wire drv = a & b;
  assign y = a | b;
  always @(posedge clk) begin
    nxt <= cnt;
  end
  always @(*) begin
    q = nxt;
  end
endmodule
`;
    expect(drives(code)).toEqual([
      'drv@5', // inline net-declaration driver
      'y@6',   // continuous assign
      'nxt@8', // nonblocking, inside always @(posedge)
      'q@11',  // blocking, inside always @(*)
    ]);
  });

  it('recurses into a concatenation lvalue and ignores the bit-select index', () => {
    // `{q[3], q[2]} = cnt[1:0]` drives q twice. A flat read would yield the
    // literal text `{q[3], q[2]}`; walking the index expression would wrongly
    // report cnt (which is READ) as driven.
    const code = `
module m(output reg [3:0] q);
  wire [3:0] cnt;
  assign {q[3], q[2]} = cnt[1:0];
endmodule
`;
    expect(drives(code)).toEqual(['q@4', 'q@4']);
  });

  it('does not treat a less-than-or-equal comparison as a driver', () => {
    // `a <= b` inside a condition is a comparison, not a nonblocking assignment.
    const code = `
module m(input [3:0] a, input [3:0] b, output reg hit);
  always @(*) begin
    if (a <= b) hit = 1'b1;
    else        hit = 1'b0;
  end
endmodule
`;
    expect(drives(code)).toEqual(['hit@4', 'hit@5']);
  });
});

describe('SystemVerilog instance names on instantiation edges', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexFiles(files: Record<string, string>): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-inst-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  /** `<instance>@L<line>` for every instantiates edge out of the named module. */
  function instancesIn(graph: CodeGraph, parent: string): string[] {
    const node = graph.getNodesByKind('module').find((n) => n.name === parent);
    expect(node, `module ${parent}`).toBeDefined();
    return graph
      .getOutgoingEdges(node!.id)
      .filter((e) => e.kind === 'instantiates')
      .map((e) => `${(e.metadata as { instance?: string } | undefined)?.instance ?? '<none>'}@L${e.line}`)
      .sort();
  }

  it('records the instance label on every instantiation edge', async () => {
    cg = await indexFiles({
      'design.v': `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z);
  leaf u_leaf(.a(x), .y(z));
endmodule
`,
    });
    expect(instancesIn(cg, 'top')).toEqual(['u_leaf@L6']);
  });

  it('distinguishes two instantiations of the same module in one parent', async () => {
    // A parent that instantiates the same module twice: without a name the
    // two edges differ only by line number.
    cg = await indexFiles({
      'dual.v': `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z1, output z2);
  leaf u_main(.a(x), .y(z1));
  leaf u_sub (.a(x), .y(z2));
endmodule
`,
    });
    expect(instancesIn(cg, 'top')).toEqual(['u_main@L6', 'u_sub@L7']);
  });

  it('gives each instance of a multi-instance statement its own name', async () => {
    // `leaf u_a(...), u_b(...);` is one statement and two instances. Emitting
    // per-statement would collapse them into a single edge.
    cg = await indexFiles({
      'multi.v': `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z1, output z2);
  leaf u_a(.a(x), .y(z1)), u_b(.a(x), .y(z2));
endmodule
`,
    });
    expect(instancesIn(cg, 'top')).toEqual(['u_a@L6', 'u_b@L6']);
  });

  it('leaves no instance marker unresolved after indexing', async () => {
    cg = await indexFiles({
      'design.v': `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z);
  leaf u_leaf(.a(x), .y(z));
  missing_leaf u_ghost(.a(x));
endmodule
`,
    });
    // Opens its own connection (the CodeGraph handle can't read the residual
    // ref table) and closes it so teardown's destroy() doesn't trip a Windows
    // file lock — same pattern as lingeringHandleRefs above.
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_inst__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    // Both markers are consumed: the bound one patches its edge, and the one
    // whose module type never resolved patches nothing and is still dropped.
    expect(left).toEqual([]);
  });
});

describe('SystemVerilog driver edges — module-scoped binding', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexFiles(files: Record<string, string>): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-drives-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  /** `<driverName>@L<line>` for every drives edge into the named signal in `file`. */
  function driversOf(graph: CodeGraph, signal: string, file: string): string[] {
    const node = graph
      .getNodesByKind('field')
      .find((n) => n.name === signal && n.filePath === file);
    expect(node, `signal ${signal} in ${file}`).toBeDefined();
    return graph
      .getCallers(node!.id)
      .filter((c) => c.edge.kind === 'drives')
      .map((c) => `${c.node.name}@L${c.edge.line}`)
      .sort();
  }

  it('binds a drive to the writing module, never to a same-named net elsewhere', async () => {
    // `nxt` and `cnt` exist in BOTH modules. Global name matching would happily
    // cross-bind them; Verilog scope says a procedural assignment can only
    // write a signal declared in its own module.
    cg = await indexFiles({
      'core.v': `
module core(input clk, output reg [3:0] nxt);
  wire [3:0] cnt;
  always @(posedge clk) nxt <= cnt;
endmodule
`,
      'other.v': `
module other(input clk, output reg [3:0] nxt);
  wire [3:0] cnt;
  always @(posedge clk) nxt <= cnt;
endmodule
`,
    });
    expect(driversOf(cg, 'nxt', 'core.v')).toEqual(['core@L4']);
    expect(driversOf(cg, 'nxt', 'other.v')).toEqual(['other@L4']);
  });

  it('keeps every write site as its own edge, and leaves input ports undriven', async () => {
    cg = await indexFiles({
      'multi.v': `
module multi(input clk, input sel, output reg y);
  always @(*) begin
    if (sel) y = 1'b1;
    else     y = 1'b0;
  end
endmodule
`,
    });
    const y = cg.getNodesByKind('field').find((n) => n.name === 'y' && n.filePath === 'multi.v');
    expect(y).toBeDefined();

    // Both write sites survive as distinct edges — a multi-driven net is a real
    // RTL bug class, so losing a site would hide it.
    const sites = cg
      .getIncomingEdges(y!.id)
      .filter((e) => e.kind === 'drives')
      .map((e) => e.line)
      .sort();
    expect(sites).toEqual([4, 5]);

    // getCallers collapses one caller reached by several edges (#1086), so the
    // driving MODULE is reported once. That is the callers contract, not a
    // dropped edge — the site list above is where the per-line detail lives.
    expect(driversOf(cg, 'y', 'multi.v')).toEqual(['multi@L4']);

    expect(driversOf(cg, 'clk', 'multi.v')).toEqual([]);
    expect(driversOf(cg, 'sel', 'multi.v')).toEqual([]);
  });

  it('drops a hierarchical write rather than guessing a local signal of the same name', async () => {
    // A testbench writing `dut.rstn` must NOT produce an edge to the
    // testbench's own `rstn` — that would be an invented fact.
    cg = await indexFiles({
      'tb.sv': `
module tb;
  reg rstn;
  initial begin
    dut.rstn = 1'b0;
  end
endmodule
`,
    });
    expect(driversOf(cg, 'rstn', 'tb.sv')).toEqual([]);
  });
});
