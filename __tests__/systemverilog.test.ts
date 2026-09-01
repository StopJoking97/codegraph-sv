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

describe('SystemVerilog port-connection edges (across the module wall)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-conn-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  /**
   * Every connects edge as `<sourceQName> -> <targetQName> [<instance>.<port>
   * <dir>] @L<line>`, sorted. Qualified names carry the module, so an edge that
   * crossed the wall to the wrong module's port is visible in the string.
   */
  function connectionsOf(graph: CodeGraph): string[] {
    const out: string[] = [];
    for (const node of graph.getNodesByKind('field')) {
      for (const e of graph.getOutgoingEdges(node.id)) {
        if (e.kind !== 'connects') continue;
        const m = (e.metadata ?? {}) as {
          port?: string;
          portDirection?: string;
          instance?: string;
          bidirectional?: boolean;
        };
        const target = graph.getNode(e.target);
        out.push(
          `${node.qualifiedName} -> ${target?.qualifiedName ?? e.target}` +
            ` [${m.instance ?? '?'}.${m.port ?? '?'} ${m.portDirection ?? '?'}` +
            `${m.bidirectional ? ' bidi' : ''}] @L${e.line}`
        );
      }
    }
    return out.sort();
  }

  const CHILD = `
module child(input clk, input [3:0] d, output y, inout sda);
  assign y = |d;
endmodule
`;

  it('emits one edge per named connection, directed by the port direction', async () => {
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire sys_clk, out1, sda_bus;
  wire [3:0] data;
  child u_a (.clk(sys_clk), .d(data), .y(out1), .sda(sda_bus));
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      // inputs: the actual drives the formal
      'top::data -> child::d [u_a.d input] @L5',
      'top::sda_bus -> child::sda [u_a.sda inout bidi] @L5',
      'top::sys_clk -> child::clk [u_a.clk input] @L5',
      // output: the formal drives the actual
      'child::y -> top::out1 [u_a.y output] @L5',
    ].sort());
  });

  it('rebuilds named, positional and wildcard connections after an incremental sync', async () => {
    // Editing the PARENT re-extracts only the parent. Two defects met here:
    // sync never ran the SV post-passes at all (so every input-direction
    // connection vanished, while output-direction ones survived through the
    // cross-file edge reattachment — a half-graph that looks whole), and the
    // child's `__sv_portlist__` marker was consumed at the first index, so even
    // once the passes ran there was no port order left and the positional and
    // `.*` connections could never come back without a full re-index.
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire clk, d, y, sda;
  child u_named (.clk(clk), .d(d), .y(y), .sda(sda));
  child u_pos (clk, d, y, sda);
  child u_wild (.*);
endmodule
`,
    });
    const before = connectionsOf(cg!);
    // All three instantiations bind all four ports.
    expect(before.length).toBe(12);

    // A comment-only edit: same ports, same nets, one extra line.
    fs.writeFileSync(
      path.join(tempDir, 'top.v'),
      `
// touched
module top;
  wire clk, d, y, sda;
  child u_named (.clk(clk), .d(d), .y(y), .sda(sda));
  child u_pos (clk, d, y, sda);
  child u_wild (.*);
endmodule
`
    );
    await cg!.sync();

    // Every connection returns, each shifted by the one inserted line.
    expect(connectionsOf(cg!)).toEqual(
      before.map((s) => s.replace(/@L(\d+)$/, (_, n) => `@L${Number(n) + 1}`)).sort()
    );
  });

  it('keeps the output-direction connection when the CHILD is the file that changed', async () => {
    // The other direction, and the more ordinary edit: touching a leaf module.
    // Nothing re-extracts the parent, so its `__sv_conn__` markers stay consumed
    // and the connect pass has nothing to rebuild from — meanwhile the FK
    // cascade has already taken the output edge along with the port node it was
    // sourced at. Input and inout connections are rescued by the incoming-edge
    // reattachment, so the graph came back looking complete while every
    // "what does this module drive upward" answer had quietly lost an arm.
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire sys_clk, out1, sda_bus;
  wire [3:0] data;
  child u_a (.clk(sys_clk), .d(data), .y(out1), .sda(sda_bus));
endmodule
`,
    });
    const before = connectionsOf(cg!);
    expect(before).toContain('child::y -> top::out1 [u_a.y output] @L5');
    expect(before.length).toBe(4);

    // A comment-only edit of the CHILD. Every port keeps its name, so every
    // connection is still true; only the child's node ids move.
    fs.writeFileSync(path.join(tempDir, 'child.v'), `// touched${CHILD}`);
    await cg!.sync();

    // The instantiation site never moved, so the line stamps are unchanged.
    expect(connectionsOf(cg!)).toEqual(before);
  });

  it('re-sources a child edit at the PORT, not at a same-named internal register', async () => {
    // `module m(y); output y; reg y;` is ordinary legacy Verilog — the output is
    // re-declared as a net so a procedural block can drive it — and it leaves
    // TWO `field:y` nodes in one file. Real RTL has many
    // output connections on that shape. A rescue keyed on (kind, name) keeps
    // whichever node the walk saw last, which is the register, so the connection
    // came back sourced at the reg while the PORT kept no outgoing edge: the gap
    // the rescue exists to close, reproduced for every output port of that shape.
    //
    // The previous test could not see this. It preserved every line number, so
    // no node id moved and the stale edge stayed valid, and it rendered
    // qualifiedName, which is `child::y` for the port and the register alike.
    cg = await indexFiles({
      'child.v': `
module child(input clk, output y);
  reg y;
  always @(posedge clk) y <= 1'b1;
endmodule
`,
      'top.v': `
module top;
  wire sys_clk, out1;
  child u_a (.clk(sys_clk), .y(out1));
endmodule
`,
    });

    /** The node an output-direction connection is sourced at, with its decorators. */
    const outputSource = (): { name: string; decorators: string[] } | undefined => {
      for (const n of cg!.getNodesByKind('field')) {
        for (const e of cg!.getOutgoingEdges(n.id)) {
          if (e.kind !== 'connects') continue;
          if ((e.metadata as { portDirection?: string } | undefined)?.portDirection !== 'output') continue;
          const src = cg!.getNode(e.source);
          return { name: src?.name ?? '?', decorators: src?.decorators ?? [] };
        }
      }
      return undefined;
    };

    expect(outputSource()).toEqual({ name: 'y', decorators: expect.arrayContaining(['output']) });

    // Edit the CHILD, and shift its lines so every node id in it actually moves.
    fs.writeFileSync(
      path.join(tempDir, 'child.v'),
      `
// touched
module child(input clk, output y);
  reg y;
  always @(posedge clk) y <= 1'b1;
endmodule
`
    );
    await cg!.sync();

    // Still one output connection, still sourced at the PORT.
    const after = outputSource();
    expect(after).toBeDefined();
    expect(after!.decorators).toContain('output');
  });

  it('resolves positional connections, and a skipped one does not shift the rest', async () => {
    // `child u (sys_clk, , out1, sda_bus)` leaves port 1 (`d`) unconnected.
    // The grammar emits NO node for the empty slot, so counting connections by
    // node index would bind `out1` to `d` and `sda_bus` to `y`.
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire sys_clk, out1, sda_bus;
  child u_p (sys_clk, , out1, sda_bus);
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      'top::sda_bus -> child::sda [u_p.sda inout bidi] @L4',
      'top::sys_clk -> child::clk [u_p.clk input] @L4',
      'child::y -> top::out1 [u_p.y output] @L4',
    ].sort());
  });

  it('resolves positional connections against a non-ANSI header, not declaration order', async () => {
    // The header order is (a, y); the direction declarations are in the OPPOSITE
    // order. Sorting the child's port nodes by line would bind both backwards.
    cg = await indexFiles({
      'leaf.v': `
module leaf_na(a, y);
  output y;
  input a;
  assign y = ~a;
endmodule
`,
      'top.v': `
module top;
  wire src, dst;
  leaf_na u_n (src, dst);
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      'top::src -> leaf_na::a [u_n.a input] @L4',
      'leaf_na::y -> top::dst [u_n.y output] @L4',
    ].sort());
  });

  it('treats `.clk` as implicit-named and `.y()` as unconnected', async () => {
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire clk, d, sda;
  child u_i (.clk, .d, .y(), .sda(sda));
endmodule
`,
    });
    // `.y()` is deliberately floating, so no edge — the two forms parse
    // identically and only the parentheses tell them apart.
    expect(connectionsOf(cg!)).toEqual([
      'top::clk -> child::clk [u_i.clk input] @L4',
      'top::d -> child::d [u_i.d input] @L4',
      'top::sda -> child::sda [u_i.sda inout bidi] @L4',
    ].sort());
  });

  it('records every net of an expression actual and no edge for a literal', async () => {
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire lo, hi, sda_bus;
  child u_e (.clk(1'b0), .d({lo, hi}), .y(), .sda(sda_bus));
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      'top::hi -> child::d [u_e.d input] @L4',
      'top::lo -> child::d [u_e.d input] @L4',
      'top::sda_bus -> child::sda [u_e.sda inout bidi] @L4',
    ].sort());
  });

  it('expands a wildcard connection against the child port list', async () => {
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire clk, y, sda;
  wire [3:0] d;
  child u_w (.*);
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      'top::clk -> child::clk [u_w.clk input] @L5',
      'top::d -> child::d [u_w.d input] @L5',
      'top::sda -> child::sda [u_w.sda inout bidi] @L5',
      'child::y -> top::y [u_w.y output] @L5',
    ].sort());
  });

  it('binds the formal to the PORT, not to a net re-declared to drive it', async () => {
    // Legacy Verilog re-declares an output as a reg so a procedural block can
    // write it, leaving two same-named members. A last-write-wins member lookup
    // binds the connection to the internal register instead of to the port.
    cg = await indexFiles({
      'leaf.v': `
module leaf_reg(y);
  output y;
  reg y;
  initial y = 1'b0;
endmodule
`,
      'top.v': `
module top;
  wire dst;
  leaf_reg u_r (.y(dst));
endmodule
`,
    });
    const edges = connectionsOf(cg!);
    expect(edges).toEqual(['leaf_reg::y -> top::dst [u_r.y output] @L4']);
    // The port and the driving register are distinct nodes; the edge must start
    // at the one carrying the direction decorator.
    const source = cg!
      .getNodesByKind('field')
      .filter((n) => n.name === 'y' && n.filePath === 'leaf.v');
    expect(source.length).toBe(2);
  });

  it('keeps two instantiations of the same child on the same net distinct', async () => {
    // Both connections share a scope, a port name and a net name. If the marker
    // did not carry its instantiation site, the delete key would collapse them
    // and one would be lost.
    cg = await indexFiles({
      'child.v': CHILD,
      'top.v': `
module top;
  wire sys_clk;
  child u_1 (.clk(sys_clk));
  child u_2 (.clk(sys_clk));
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([
      'top::sys_clk -> child::clk [u_1.clk input] @L4',
      'top::sys_clk -> child::clk [u_2.clk input] @L5',
    ]);
  });

  it('drops a connection whose child module is not indexed, and leaves no marker', async () => {
    cg = await indexFiles({
      'top.v': `
module top;
  wire sys_clk;
  vendor_cell u_v (.clk(sys_clk));
endmodule
`,
    });
    expect(connectionsOf(cg!)).toEqual([]);

    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_conn__%' OR reference_name LIKE '__sv_portlist__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    expect(left).toEqual([]);
  });
});

describe('SystemVerilog read edges (what reads this net)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-reads-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function signal(graph: CodeGraph, name: string, file: string): Node {
    const node = graph
      .getNodesByKind('field')
      .find((n) => n.name === name && n.filePath === file);
    expect(node, `signal ${name} in ${file}`).toBeDefined();
    return node!;
  }

  /** `<reader>@[lines]` for every reads edge into the named signal. */
  function readersOf(graph: CodeGraph, name: string, file: string): string[] {
    return graph
      .getIncomingEdges(signal(graph, name, file).id)
      .filter((e) => e.kind === 'reads')
      .map((e) => {
        const reader = graph.getNode(e.source);
        const lines = (e.metadata as { lines?: number[] } | undefined)?.lines ?? [];
        return `${reader?.name ?? e.source}@[${lines.join(',')}]`;
      })
      .sort();
  }

  /** `<driver>@L<line>` for every drives edge into the named signal. */
  function driversOf(graph: CodeGraph, name: string, file: string): string[] {
    return graph
      .getIncomingEdges(signal(graph, name, file).id)
      .filter((e) => e.kind === 'drives')
      .map((e) => `${graph.getNode(e.source)?.name ?? e.source}@L${e.line}`)
      .sort();
  }

  it('never reports an assignment target as a read of itself', async () => {
    // The bug this feature exists to prevent: if "any identifier under the
    // statement" counted as a read, `q <= d` would make q a reader of q, and
    // "what reads q" would return q's own writer.
    cg = await indexFiles({
      'ff.v': `
module ff(input clk, input d, output reg q);
  always @(posedge clk) q <= d;
endmodule
`,
    });
    expect(readersOf(cg!, 'q', 'ff.v')).toEqual([]);
    expect(readersOf(cg!, 'd', 'ff.v')).toEqual(['ff@[3]']);
    expect(driversOf(cg!, 'q', 'ff.v')).toEqual(['ff@L3']);
  });

  it('captures sensitivity-list, condition, index, concat, ternary and argument reads', async () => {
    cg = await indexFiles({
      'r.v': `
module r(input clk, input rstn, input [3:0] sel, input [7:0] a, input [7:0] b, output reg [7:0] y);
  reg [7:0] mem [0:15];
  always @(posedge clk or negedge rstn) begin
    if (rstn) y <= sel[0] ? {a[3:0], b[3:0]} : mem[sel];
  end
  function [7:0] pick(input [7:0] v); pick = v; endfunction
endmodule
`,
    });
    // clk + rstn from the sensitivity list, rstn again from the condition,
    // sel from both the ternary condition and the memory index, a and b from
    // the concatenation.
    expect(readersOf(cg!, 'clk', 'r.v')).toEqual(['r@[4]']);
    expect(readersOf(cg!, 'rstn', 'r.v')).toEqual(['r@[4,5]']);
    expect(readersOf(cg!, 'sel', 'r.v')).toEqual(['r@[5]']);
    expect(readersOf(cg!, 'a', 'r.v')).toEqual(['r@[5]']);
    expect(readersOf(cg!, 'b', 'r.v')).toEqual(['r@[5]']);
  });

  it('counts an index on the LEFT-hand side as a read of the index signal', async () => {
    // `mem[sel] <= d` WRITES mem and READS sel. The grammar nests the index
    // under its own primary even inside an lvalue, which is why anchoring on
    // the parent construct gets this right without a special case.
    cg = await indexFiles({
      'w.v': `
module w(input clk, input [3:0] sel, input [7:0] d);
  reg [7:0] mem [0:15];
  always @(posedge clk) mem[sel] <= d;
endmodule
`,
    });
    expect(readersOf(cg!, 'sel', 'w.v')).toEqual(['w@[4]']);
    expect(readersOf(cg!, 'mem', 'w.v')).toEqual([]);
    expect(driversOf(cg!, 'mem', 'w.v')).toEqual(['w@L4']);
  });

  it('aggregates every site of one (reader, net) pair into one edge with all lines', async () => {
    cg = await indexFiles({
      'agg.v': `
module agg(input en, output reg x, output reg y, output reg z);
  always @(*) begin
    x = en;
    y = ~en;
    z = en & 1'b1;
  end
endmodule
`,
    });
    expect(readersOf(cg!, 'en', 'agg.v')).toEqual(['agg@[4,5,6]']);
    const edges = cg!
      .getIncomingEdges(signal(cg!, 'en', 'agg.v').id)
      .filter((e) => e.kind === 'reads');
    expect(edges.length).toBe(1); // one edge, not one per site
    expect(edges[0]!.line).toBe(4); // anchored at the first site
  });

  it('grows the line list on re-index rather than leaving it stale', async () => {
    cg = await indexFiles({
      'grow.v': `
module grow(input en, output reg x, output reg y);
  always @(*) begin
    x = en;
  end
endmodule
`,
    });
    expect(readersOf(cg!, 'en', 'grow.v')).toEqual(['grow@[4]']);

    // Add a second read BELOW the first. INSERT OR IGNORE against the identity
    // index would keep the old one-element list forever.
    //
    // Through sync(), the INCREMENTAL path — the watcher's and the CLI's. It
    // used to drop the SV edges entirely (the generic resolver parks the markers
    // status='failed' and the batched path that runs the SV passes is
    // unreachable from the scoped branch), so this test had to re-index in full
    // to say anything. sync() now runs the SV post-passes itself.
    fs.writeFileSync(
      path.join(tempDir, 'grow.v'),
      `
module grow(input en, output reg x, output reg y);
  always @(*) begin
    x = en;
    y = ~en;
  end
endmodule
`
    );
    await cg!.sync();
    expect(readersOf(cg!, 'en', 'grow.v')).toEqual(['grow@[4,5]']);
  });

  it('leaves the driver answer intact for a net that is both read and driven', async () => {
    // A read and a drive on the same net share a SOURCE (the module does both).
    // If `reads` joined the caller traversal, its visited-set would keep only
    // one of them and "what drives this net" would start returning a reader.
    cg = await indexFiles({
      'both.v': `
module both(input clk, output reg [7:0] cnt);
  always @(posedge clk) cnt <= cnt + 1;
endmodule
`,
    });
    expect(driversOf(cg!, 'cnt', 'both.v')).toEqual(['both@L3']);
    expect(readersOf(cg!, 'cnt', 'both.v')).toEqual(['both@[3]']);

    // getCallers is the driver answer's surface; it must still report the drive.
    const callers = cg!
      .getCallers(signal(cg!, 'cnt', 'both.v').id)
      .map((c) => `${c.node.name}:${c.edge.kind}`);
    expect(callers).toContain('both:drives');
    expect(callers.some((c) => c.endsWith(':reads'))).toBe(false);
  });

  it('binds a read to the reading module, never to a same-named net elsewhere', async () => {
    cg = await indexFiles({
      'a.v': `
module a(input en, output reg x);
  always @(*) x = en;
endmodule
`,
      'b.v': `
module b(input en, output reg x);
  always @(*) x = ~en;
endmodule
`,
    });
    expect(readersOf(cg!, 'en', 'a.v')).toEqual(['a@[3]']);
    expect(readersOf(cg!, 'en', 'b.v')).toEqual(['b@[3]']);
  });

  it('drops a hierarchical read and leaves no marker behind', async () => {
    cg = await indexFiles({
      'tb.sv': `
module tb;
  reg rstn;
  initial if (dut.rstn) rstn = 1'b0;
endmodule
`,
    });
    // `dut.rstn` names another module's signal; guessing the local `rstn`
    // would invent a fact.
    expect(readersOf(cg!, 'rstn', 'tb.sv')).toEqual([]);

    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_read__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    expect(left).toEqual([]);
  });
});

describe('SystemVerilog hierarchical reference edges (testbench probes)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-hier-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  /**
   * Every hier_ref and hierarchical drive out of the named source, as
   * `<kind> <path> -> <targetQName>[ PARTIAL:<tail>]`.
   */
  function pathsFrom(graph: CodeGraph, sourceName: string): string[] {
    const src =
      graph.getNodesByKind('module').find((n) => n.name === sourceName) ??
      graph.getNodesByKind('file').find((n) => n.name === sourceName);
    expect(src, `source ${sourceName}`).toBeDefined();
    return graph
      .getOutgoingEdges(src!.id)
      .filter((e) => e.kind === 'hier_ref' || (e.kind === 'drives' && (e.metadata as { path?: string })?.path))
      .map((e) => {
        const m = (e.metadata ?? {}) as { path?: string; partial?: boolean; unresolvedTail?: string };
        const target = graph.getNode(e.target);
        return `${e.kind} ${m.path} -> ${target?.qualifiedName ?? e.target}${m.partial ? ` PARTIAL:${m.unresolvedTail}` : ''}`;
      })
      .sort();
  }

  const DESIGN = {
    'leaf.v': `
module leaf(input clk, output reg [7:0] state);
  always @(posedge clk) state <= state + 1;
endmodule
`,
    'core.v': `
module core(input clk);
  leaf u_leaf(.clk(clk));
endmodule
`,
    'top_dut.v': `
module top_dut(input clk);
  core u_core(.clk(clk));
endmodule
`,
  };

  it('resolves an absolute path rooted at the elaboration top, end to end', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'tb.sv': `
module tb;
  reg clk;
  initial if (top_dut.u_core.u_leaf.state == 8'h5) clk = 1'b0;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb')).toEqual([
      'hier_ref top_dut.u_core.u_leaf.state -> leaf::state',
    ]);
  });

  it('resolves a relative path against its enclosing scope', async () => {
    // `u_core` is not a module name — it is an INSTANCE visible inside top_dut.
    cg = await indexFiles({
      ...DESIGN,
      'probe.v': `
module top_probe(input clk);
  core u_core(.clk(clk));
  wire [7:0] tap = u_core.u_leaf.state;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'top_probe')).toEqual([
      'hier_ref u_core.u_leaf.state -> leaf::state',
    ]);
  });

  it('emits nothing when the root matches neither a module nor a visible instance', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'tb.sv': `
module tb;
  reg clk;
  initial if (nowhere.u_core.state == 1) clk = 1'b0;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb')).toEqual([]);
  });

  it('never guesses among same-named instances in unrelated blocks', async () => {
    // `u_leaf` exists inside BOTH blk_a and blk_b. A globally-unique-instance
    // fallback would bind tb's path to whichever it found first, which is the
    // only silent-wrongness mode this feature set could have had.
    cg = await indexFiles({
      'leaf.v': `
module leaf(input clk, output reg [7:0] state);
  always @(posedge clk) state <= state + 1;
endmodule
`,
      'blocks.v': `
module blk_a(input clk);
  leaf u_leaf(.clk(clk));
endmodule
module blk_b(input clk);
  leaf u_leaf(.clk(clk));
endmodule
`,
      'tb.sv': `
module tb;
  reg clk;
  initial if (u_leaf.state == 1) clk = 1'b0;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb')).toEqual([]);
  });

  it('reads a local struct-member write as a member select, not a cross-module drive', async () => {
    // `bus` is a local variable in `a` AND the name of an unrelated module. The
    // root lookup used to consult the global module table first, so this plain
    // member write became a confident `drives` edge onto bus::valid — a
    // fabricated back-door driver, with tree-sitter provenance, in the driver
    // answer. Common RTL names (bus, ctrl, fifo, core) make the collision routine.
    cg = await indexFiles({
      'a.sv': `
typedef struct packed { logic valid; logic [7:0] data; } bus_t;
module a;
  bus_t bus;
  always_comb bus.valid = 1'b1;
endmodule
`,
      'bus.sv': `
module bus(input clk, output reg valid);
  always @(posedge clk) valid <= 1'b1;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'a')).toEqual([]);
  });

  it('drops a member select whose subject came from an imported package, not the module', async () => {
    // The local-member rule reads the emitting scope's DIRECT `contains`
    // children. A package-imported subject is parented by the `namespace`, so it
    // slips past that rule and reaches the global module lookup — which is
    // exactly where the fabricated cross-module driver came from. Same write,
    // same collision, different parent.
    cg = await indexFiles({
      'cfg_pkg.sv': `
package cfg_pkg;
  typedef struct packed { logic valid; logic [7:0] data; } bus_t;
  bus_t bus;
endpackage
`,
      'a.sv': `
module a;
  import cfg_pkg::*;
  always_comb bus.valid = 1'b1;
endmodule
`,
      'bus.sv': `
module bus(input clk, output reg valid);
  always @(posedge clk) valid <= 1'b1;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'a')).toEqual([]);
  });

  it('drops a member select whose subject was declared at file scope, not in the module', async () => {
    // The other way past the local-member rule: a declaration pulled in by
    // `` `include `` is a child of the HEADER's file node, never of the module
    // doing the writing. Not a corner case — real RTL carries many
    // declarations parented directly by a file node.
    cg = await indexFiles({
      'sigs.vh': `
bus_t bus;
`,
      'm.sv': `
module m;
  \`include "sigs.vh"
  always_comb bus.valid = 1'b1;
endmodule
`,
      'bus.sv': `
module bus(input clk, output reg valid);
  always @(posedge clk) valid <= 1'b1;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'm')).toEqual([]);
  });

  it('drops a member select whose subject is a subroutine, not just a signal', async () => {
    // The third way past the local-member rule, and the one the narrower kind
    // set left open: a hierarchical path can legally END at a function or task,
    // so a function name is just as capable of being the real subject as a
    // signal is. Testing only the signal kinds let `module ctrl` capture a path
    // rooted at a same-named subroutine.
    cg = await indexFiles({
      'a.sv': `
module a;
  function automatic void ctrl();
  endfunction
  always_comb ctrl.done = 1'b1;
endmodule
`,
      'ctrl.sv': `
module ctrl(input clk, output reg done);
  always @(posedge clk) done <= 1'b1;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'a')).toEqual([]);
  });

  it('drops a member select on an instance whose module is not in the index', async () => {
    // The subject is an INSTANCE, and instances get no node of their own — the
    // label lives in the `instantiates` edge's metadata, which only exists once
    // the instantiated module resolves. A vendor cell outside the index never
    // resolves, so the label is invisible to every rule, and the root falls
    // through to the global module lookup where a same-named module is waiting.
    cg = await indexFiles({
      'm.sv': `
module m;
  vendor_ip bus(.clk(1'b0));
  always_comb bus.valid = 1'b1;
endmodule
`,
      'bus.sv': `
module bus(input clk, output reg valid);
  always @(posedge clk) valid <= 1'b1;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'm')).toEqual([]);
  });

  it('still resolves a probe when an unrelated module happens to declare the same name', async () => {
    // The cost of getting the member-select test wrong in the other direction.
    // A test that asks "does this name exist ANYWHERE in the index" stops the
    // fabricated edge and takes the legitimate ones with it: a design's top
    // module roots nearly every hierarchical edge, so one `reg top`
    // or `` `define top `` in any file would have deleted all of them, with
    // no error and no marker left behind to notice. Visibility is scoped for
    // this reason — a declaration in a module this scope cannot see does not get
    // a vote on what this scope meant.
    cg = await indexFiles({
      ...DESIGN,
      'other.sv': `
module other;
  reg top_dut;
  always_comb top_dut = 1'b0;
endmodule
`,
      'tb.sv': `
module tb;
  reg clk;
  initial if (top_dut.u_core.u_leaf.state == 8'h5) clk = 1'b0;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb')).toEqual(['hier_ref top_dut.u_core.u_leaf.state -> leaf::state']);
  });

  it('keeps an absolute probe inside its own design when two designs share a top name', async () => {
    // `module tb` in two designs is routine in verification repos. Binding the
    // root by global name took the first in file-path order, so design B's probe
    // reached into design A and drove ITS signal.
    cg = await indexFiles({
      'a_tb.sv': `
module tb_top;
  dut_a u_dut();
endmodule
`,
      'a_dut.sv': `
module dut_a;
  logic sig;
endmodule
`,
      'b_tb.sv': `
module tb_top;
  dut_b u_dut();
  initial force tb_top.u_dut.sig = 1'b0;
endmodule
`,
      'b_dut.sv': `
module dut_b;
  logic sig;
endmodule
`,
    });
    // Resolved against the EMITTING module, so it can only reach dut_b.
    const paths = cg!
      .getNodesByKind('module')
      .filter((n) => n.name === 'tb_top')
      .flatMap((n) =>
        cg!
          .getOutgoingEdges(n.id)
          .filter((e) => e.kind === 'hier_ref' || (e.kind === 'drives' && (e.metadata as { path?: string })?.path))
          .map((e) => `${e.kind} -> ${cg!.getNode(e.target)?.qualifiedName}`)
      );
    expect(paths).toEqual(['drives -> dut_b::sig']);
  });

  it('never binds a hierarchical root to a module node from another language', async () => {
    // terraform and cobol also emit kind 'module', and the name lookup had no
    // language predicate — so `module "tb_top"` in a .tf file could capture the
    // root of a SystemVerilog probe purely on file-path sort order.
    cg = await indexFiles({
      '_infra.tf': `
module "tb_top" {
  source = "./x"
}
`,
      'tb.sv': `
module tb_top;
  dut_b u_dut();
  initial force tb_top.u_dut.sig = 1'b0;
endmodule
`,
      'dut_b.sv': `
module dut_b;
  logic sig;
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb_top')).toEqual(['drives tb_top.u_dut.sig -> dut_b::sig']);
  });

  it('labels a path that resolves only partway, and never calls it a drive', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'tb.sv': `
module tb;
  reg clk;
  initial if (top_dut.u_missing.state == 1) clk = 1'b0;
  initial force top_dut.u_missing.state = 8'h0;
endmodule
`,
    });
    // Both stop at top_dut. The force stays hier_ref — claiming a MODULE is
    // driven would be a wrong answer, not an incomplete one.
    expect(pathsFrom(cg!, 'tb')).toEqual([
      'hier_ref top_dut.u_missing.state -> top_dut PARTIAL:u_missing.state',
      'hier_ref top_dut.u_missing.state -> top_dut PARTIAL:u_missing.state',
    ]);
  });

  it('makes a hierarchical force reach the driver answer for the forced signal', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'tb.sv': `
module tb;
  initial begin
    force top_dut.u_core.u_leaf.state = 8'h0;
    release top_dut.u_core.u_leaf.state;
  end
endmodule
`,
    });
    expect(pathsFrom(cg!, 'tb')).toEqual([
      'drives top_dut.u_core.u_leaf.state -> leaf::state',
      'drives top_dut.u_core.u_leaf.state -> leaf::state',
    ]);

    // The driver answer is what an engineer actually queries.
    const state = cg!.getNodesByKind('field').find((n) => n.name === 'state' && n.filePath === 'leaf.v');
    const drivers = cg!
      .getCallers(state!.id)
      .filter((c) => c.edge.kind === 'drives')
      .map((c) => c.node.name)
      .sort();
    expect(drivers).toEqual(['leaf', 'tb']);
  });

  it('produces no hierarchical marker for class-handle member access', async () => {
    cg = await indexFiles({
      'cls.sv': `
class cfg_c;
  int value;
endclass
class env_c;
  cfg_c cfg;
  function void go();
    cfg.value = 5;
    $display("%d", cfg.value);
  endfunction
endclass
`,
    });
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_hier__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    // Object member access is byte-identical to hierarchical navigation in the
    // AST; unbounded markers there would explode on class-based testbenches.
    expect(left).toEqual([]);
    expect(cg!.getNodesByKind('class').map((n) => n.name).sort()).toEqual(['cfg_c', 'env_c']);
  });

  it('resolves a path in an include fragment that has no enclosing module', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'probe.vh': `
initial if (top_dut.u_core.u_leaf.state == 8'h5) $display("hit");
`,
    });
    expect(pathsFrom(cg!, 'probe.vh')).toEqual([
      'hier_ref top_dut.u_core.u_leaf.state -> leaf::state',
    ]);
  });

  it('leaves no hierarchical marker behind after indexing', async () => {
    cg = await indexFiles({
      ...DESIGN,
      'tb.sv': `
module tb;
  reg clk;
  initial if (top_dut.u_core.u_leaf.state == 1 || nowhere.a.b == 2) clk = 1'b0;
endmodule
`,
    });
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_hier__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    expect(left).toEqual([]);
  });
});

describe('SystemVerilog macro definitions and uses', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-macro-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  /** `<name>@<file>:<line> = <signature>` for every macro definition node. */
  function macrosIn(graph: CodeGraph): string[] {
    return graph
      .getNodesByKind('constant')
      .filter((n) => n.decorators?.includes('macro'))
      .map((n) => `${n.name}@${n.filePath}:${n.startLine} = ${n.signature ?? ''}`)
      .sort();
  }

  /** `<file>:<line> -> <macro>@<defFile>:<defLine>` for every macro use edge. */
  function macroUses(graph: CodeGraph): string[] {
    const out: string[] = [];
    for (const def of graph.getNodesByKind('constant')) {
      if (!def.decorators?.includes('macro')) continue;
      for (const e of graph.getIncomingEdges(def.id)) {
        if (e.kind !== 'references') continue;
        const src = graph.getNode(e.source);
        out.push(`${src?.filePath ?? '?'}:${e.line} -> ${def.name}@${def.filePath}:${def.startLine}`);
      }
    }
    return out.sort();
  }

  it('makes each `define a node carrying its value and a macro decorator', async () => {
    cg = await indexFiles({
      'defs.vh': `
\`define WIDTH 8
\`define NOP
\`define ADDR_MAX (1<<\`WIDTH)
`,
    });
    expect(macrosIn(cg!)).toEqual([
      'ADDR_MAX@defs.vh:4 = `define ADDR_MAX (1<<`WIDTH)',
      'NOP@defs.vh:3 = `define NOP',
      'WIDTH@defs.vh:2 = `define WIDTH 8',
    ]);
  });

  it('emits an edge from each use to its definition, across files', async () => {
    cg = await indexFiles({
      'defs.vh': `
\`define WIDTH 8
`,
      'top.v': `
module top;
  wire [\`WIDTH-1:0] bus;
  localparam MAX = \`WIDTH;
endmodule
`,
    });
    expect(macroUses(cg!)).toEqual([
      'top.v:3 -> WIDTH@defs.vh:2',
      'top.v:4 -> WIDTH@defs.vh:2',
    ]);
  });

  it('edges to EVERY definition when a name is defined more than once', async () => {
    // Real designs define one macro name in two
    // different files with no principled winner. Binding to a first match
    // invents an answer that changes with row order; showing both IS the answer.
    cg = await indexFiles({
      'a.vh': `\n\`define TRUE 1'b1\n`,
      'b.vh': `\n\`define TRUE 1\n`,
      'top.v': `
module top;
  localparam T = \`TRUE;
endmodule
`,
    });
    expect(macroUses(cg!)).toEqual([
      'top.v:3 -> TRUE@a.vh:2',
      'top.v:3 -> TRUE@b.vh:2',
    ]);
  });

  it('resolves a macro named in a conditional-compilation directive', async () => {
    // The pre-parse blanks directive lines before the grammar sees them (one
    // directive would otherwise swallow a whole module as an ERROR node), so
    // these names are captured from the ORIGINAL source during pre-parse.
    cg = await indexFiles({
      'defs.vh': `\n\`define FPGA\n`,
      'top.v': `
module top;
\`ifdef FPGA
  wire fpga_only;
\`else
  wire asic_only;
\`endif
endmodule
`,
    });
    expect(macroUses(cg!)).toEqual(['top.v:3 -> FPGA@defs.vh:2']);
    // Both branches still index — that property is what the blanking protects.
    const nets = cg!.getNodesByKind('field').map((n) => n.name).sort();
    expect(nets).toEqual(['asic_only', 'fpga_only']);
  });

  it('never shadows a same-named signal in the driver or reader answers', async () => {
    // A module-scoped `define and a signal both land as children of the module.
    // Dataflow answers must stay about the SIGNAL.
    cg = await indexFiles({
      'shadow.v': `
module shadow(input clk, output reg ready);
\`define ready 1'b1
  wire src;
  always @(posedge clk) ready <= src;
  wire copy = ready;
endmodule
`,
    });
    const signal = cg!
      .getNodesByKind('field')
      .find((n) => n.name === 'ready' && n.filePath === 'shadow.v');
    expect(signal).toBeDefined();

    const drivers = cg!
      .getIncomingEdges(signal!.id)
      .filter((e) => e.kind === 'drives')
      .map((e) => e.line);
    expect(drivers).toEqual([5]);

    const readers = cg!
      .getIncomingEdges(signal!.id)
      .filter((e) => e.kind === 'reads')
      .map((e) => (e.metadata as { lines?: number[] } | undefined)?.lines);
    expect(readers).toEqual([[6]]);

    // The macro node exists, and carries none of the dataflow.
    const macro = cg!
      .getNodesByKind('constant')
      .find((n) => n.name === 'ready' && n.decorators?.includes('macro'));
    expect(macro).toBeDefined();
    expect(cg!.getIncomingEdges(macro!.id).filter((e) => e.kind === 'drives' || e.kind === 'reads')).toEqual([]);
  });

  it('discards an unbindable macro marker rather than fabricating a definition', async () => {
    cg = await indexFiles({
      'stray.v': `
module stray;
  localparam X = \`NEVER_DEFINED;
endmodule
`,
    });
    expect(macrosIn(cg!)).toEqual([]);
    expect(macroUses(cg!)).toEqual([]);

    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_macro__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    expect(left).toEqual([]);
  });

  it('keeps reading the identifiers a macro invocation passes as arguments', async () => {
    // A macro call's arguments are ordinary expressions. Swallowing the usage
    // subtree would silently drop them from the fanout answer.
    cg = await indexFiles({
      'args.v': `
\`define CHECK(sig) sig
module args(input clk, input flag, output reg q);
  always @(posedge clk) q <= \`CHECK(flag);
endmodule
`,
    });
    const flag = cg!.getNodesByKind('field').find((n) => n.name === 'flag');
    const lines = cg!
      .getIncomingEdges(flag!.id)
      .filter((e) => e.kind === 'reads')
      .map((e) => (e.metadata as { lines?: number[] } | undefined)?.lines);
    expect(lines).toEqual([[4]]);
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

describe('SystemVerilog subroutine-body dataflow (reads and drives inside function/task bodies)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-subr-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), body);
    }
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function signal(graph: CodeGraph, name: string, file: string): Node {
    const node = graph
      .getNodesByKind('field')
      .find((n) => n.name === name && n.filePath === file);
    expect(node, `signal ${name} in ${file}`).toBeDefined();
    return node!;
  }

  /** `<writerQName>@L<line>` for every drives edge into the named signal. */
  function driversOf(graph: CodeGraph, name: string, file: string): string[] {
    return graph
      .getIncomingEdges(signal(graph, name, file).id)
      .filter((e) => e.kind === 'drives')
      .map((e) => `${graph.getNode(e.source)?.qualifiedName ?? e.source}@L${e.line}`)
      .sort();
  }

  /** `<readerQName>@[lines]` for every reads edge into the named signal. */
  function readersOf(graph: CodeGraph, name: string, file: string): string[] {
    return graph
      .getIncomingEdges(signal(graph, name, file).id)
      .filter((e) => e.kind === 'reads')
      .map((e) => {
        const lines = (e.metadata as { lines?: number[] } | undefined)?.lines ?? [];
        return `${graph.getNode(e.source)?.qualifiedName ?? e.source}@[${lines.join(',')}]`;
      })
      .sort();
  }

  // One module whose ENTIRE dataflow lives inside a task and a function — the
  // shape of the behavioral bus models this feature exists for.
  const MODEL = `
module i2c_model(input clk, output reg sda, output reg scl);
  reg [7:0] cfg_word;
  reg [7:0] shadow_me;
  integer   beat;

  task automatic drive_byte(input [7:0] arg);
    reg [7:0] shadow_me;
    begin
      shadow_me = arg;
      sda  = cfg_word[0];
      scl  = 1'b1;
      beat = beat + 1;
    end
  endtask

  function [7:0] next_cfg(input [7:0] v);
    next_cfg = v ^ cfg_word;
  endfunction
endmodule
`;

  it('binds a drive made inside a task body to the module-level signal', async () => {
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    // sda and scl are written ONLY from inside drive_byte. Before the
    // subroutine walker invoked the language hook these were empty: the
    // module's whole driver answer was silence.
    expect(driversOf(cg!, 'sda', 'i2c_model.v')).toEqual(['i2c_model::drive_byte@L11']);
    expect(driversOf(cg!, 'scl', 'i2c_model.v')).toEqual(['i2c_model::drive_byte@L12']);
    expect(driversOf(cg!, 'beat', 'i2c_model.v')).toEqual(['i2c_model::drive_byte@L13']);
  });

  it('binds a read made inside a task or function body to the module-level signal', async () => {
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    expect(readersOf(cg!, 'cfg_word', 'i2c_model.v')).toEqual([
      'i2c_model::drive_byte@[11]',
      'i2c_model::next_cfg@[18]',
    ]);
    // `beat = beat + 1` reads beat as well as driving it.
    expect(readersOf(cg!, 'beat', 'i2c_model.v')).toEqual(['i2c_model::drive_byte@[13]']);
  });

  it('never lets a subroutine-local declaration bind to the module signal it shadows', async () => {
    // The subtly-wrong version of this fix: retry the lookup one hop up
    // unconditionally, and `shadow_me = arg` inside the task — a write to the
    // task's OWN reg — is reported as a write to the module's shadow_me. That
    // is a confident wrong driver answer, which this branch rates worse than a
    // missing one.
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    expect(driversOf(cg!, 'shadow_me', 'i2c_model.v')).toEqual([]);
    // The task's formal argument is not a module signal either.
    expect(cg!.getNodesByKind('field').filter((n) => n.name === 'arg')).toEqual([]);
  });

  it('leaves procedural locals unindexed: the shadowing declaration creates no node', async () => {
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    // Exactly ONE shadow_me node — the module's. The task's local declaration
    // must not become a second field node.
    expect(
      cg!.getNodesByKind('field').filter((n) => n.name === 'shadow_me').length
    ).toBe(1);
  });

  it('resolves a hierarchical backdoor write made inside a task body', async () => {
    // A UVM-style reset task: a dotted write inside a task
    // produced zero hier_ref and zero drives edges.
    cg = await indexFiles({
      'leaf.v': `
module leaf(input clk, output reg [7:0] state);
  always @(posedge clk) state <= state + 1;
endmodule
`,
      'core.v': `
module core(input clk);
  leaf u_leaf(.clk(clk));
endmodule
`,
      'top_dut.v': `
module top_dut(input clk);
  core u_core(.clk(clk));
endmodule
`,
      'tb.sv': `
module tb;
  reg clk;
  task automatic reset_dut();
    begin
      top_dut.u_core.u_leaf.state = 8'h0;
    end
  endtask
endmodule
`,
    });
    const task = cg!.getNodesByKind('function').find((n) => n.name === 'reset_dut');
    expect(task, 'reset_dut task node').toBeDefined();
    const paths = cg!
      .getOutgoingEdges(task!.id)
      .filter((e) => e.kind === 'hier_ref' || (e.kind === 'drives' && (e.metadata as { path?: string })?.path))
      .map((e) => {
        const m = (e.metadata ?? {}) as { path?: string; partial?: boolean; unresolvedTail?: string };
        return `${e.kind} ${m.path} -> ${cg!.getNode(e.target)?.qualifiedName ?? e.target}${m.partial ? ` PARTIAL:${m.unresolvedTail}` : ''}`;
      })
      .sort();
    // An lvalue path that resolves end to end is backdoor stimulus — a real
    // write — so it reaches the driver answer as `drives`.
    expect(paths).toEqual(['drives top_dut.u_core.u_leaf.state -> leaf::state']);
  });

  it('does not let a subroutine-local struct handle fabricate a cross-module path', async () => {
    // Rule 1 of the hierarchical root walk drops `bus.valid` as a member select
    // when `bus` is visible in the emitting scope. A subroutine local is
    // deliberately unindexed, so it is invisible to that rule — and a module
    // named `bus` elsewhere in the design would capture the root.
    cg = await indexFiles({
      'bus.v': `
module bus(input clk, output reg valid);
  always @(posedge clk) valid <= 1'b1;
endmodule
`,
      'tb.sv': `
module tb;
  typedef struct packed { logic valid; } bus_t;
  task automatic poke();
    bus_t bus;
    begin
      bus.valid = 1'b1;
    end
  endtask
endmodule
`,
    });
    // Module bus drives its own valid — that edge is real and stays. The
    // invariant is that NOTHING from tb joins it.
    expect(driversOf(cg!, 'valid', 'bus.v')).toEqual(['bus@L3']);
  });

  it('rebuilds subroutine-body dataflow after an incremental sync (sync == full index)', async () => {
    // The fix changes WHAT the graph holds, so it must hold the same thing on
    // both paths. `[spec 2]` is the precedent: editing an SV file once erased
    // every post-pass edge in it until a full re-index put them back, which
    // scoped the whole feature to full index without saying so.
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    const before = [
      ...driversOf(cg!, 'sda', 'i2c_model.v'),
      ...driversOf(cg!, 'scl', 'i2c_model.v'),
      ...readersOf(cg!, 'cfg_word', 'i2c_model.v'),
    ];
    expect(before.length).toBe(4);

    // A comment-only edit that INSERTS a line: same dataflow, every site one
    // line lower. The shift is the point — an assertion over unmoved line
    // numbers passes just as happily on a stale edge left behind as on a
    // correctly rebuilt one.
    fs.writeFileSync(path.join(tempDir, 'i2c_model.v'), `\n// touched${MODEL}`);
    await cg!.sync();

    expect([
      ...driversOf(cg!, 'sda', 'i2c_model.v'),
      ...driversOf(cg!, 'scl', 'i2c_model.v'),
      ...readersOf(cg!, 'cfg_word', 'i2c_model.v'),
    ]).toEqual(
      before.map((s) =>
        s
          .replace(/@L(\d+)$/, (_, n) => `@L${Number(n) + 1}`)
          .replace(/@\[([\d,]+)\]$/, (_, ns: string) => `@[${ns.split(',').map((n) => Number(n) + 1).join(',')}]`)
      )
    );
  });

  it('leaves no subroutine-body marker unresolved after indexing', async () => {
    cg = await indexFiles({ 'i2c_model.v': MODEL });
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    let left: { reference_name: string }[];
    try {
      left = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_name LIKE '__sv_drive__%' OR reference_name LIKE '__sv_read__%' OR reference_name LIKE '__sv_hier__%'`
      ).all() as { reference_name: string }[];
    } finally {
      db.close();
    }
    expect(left).toEqual([]);
  });
});
