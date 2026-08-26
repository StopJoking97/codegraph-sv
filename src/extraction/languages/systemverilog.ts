import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

/**
 * SystemVerilog / Verilog extractor (tree-sitter-systemverilog grammar).
 *
 * The design hierarchy is the payload here: a module's `callers` are the modules
 * that instantiate it, its `callees`/contained children are its sub-instances and
 * subroutines, and `impact` is the instantiation cone. SystemVerilog keeps
 * declaration names nested (module name under a `*_ansi_header`, subroutine name
 * under a `*_body_declaration`, a typedef under the `type_name` field), so a single
 * resolver walks those shapes rather than relying on a flat name field.
 */

/** Resolve a declaration's identifier across SV's varied nesting. */
function svName(node: SyntaxNode, source: string): string | undefined {
  // The constructor `function new(...)` parses as class_constructor_declaration
  // with no name field — its identity is always 'new'.
  if (node.type === 'class_constructor_declaration') return 'new';

  // class_declaration / package_declaration expose `name` directly.
  const direct = getChildByField(node, 'name');
  if (direct) return getNodeText(direct, source).trim();

  // `typedef <type> NAME;` carries the alias on the `type_name` field.
  const typeName = getChildByField(node, 'type_name');
  if (typeName) return getNodeText(typeName, source).trim();

  // module/interface/program keep the name one level down in the ANSI header;
  // function/task keep it on the *_body_declaration.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (/_(ansi_|nonansi_)?header$/.test(child.type) || /_body_declaration$/.test(child.type)) {
      const nm = getChildByField(child, 'name');
      if (nm) return getNodeText(nm, source).trim();
    }
  }

  // Fallback: only an enum member names itself with a sole shallow identifier.
  // For any other node whose name didn't resolve above, return undefined so the
  // engine skips it — a skipped node beats one mislabeled with a port/param id.
  if (node.type === 'enum_name_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.type === 'simple_identifier') return getNodeText(c, source).trim();
    }
  }
  return undefined;
}

/** The instantiated module *type* (`adder` in `adder u_add (...)`), not the `u_add` label. */
function instantiatedType(node: SyntaxNode, source: string): string | undefined {
  // The grammar tags the type as the `instance_type` field; the instance label
  // lives deeper under hierarchical_instance > name_of_instance.
  const t = getChildByField(node, 'instance_type');
  if (t) return getNodeText(t, source).trim();
  const first = node.namedChild(0);
  return first && first.type === 'simple_identifier' ? getNodeText(first, source).trim() : undefined;
}

// Built-in data types that can surface as a bare identifier under data_type
// (most lower to dedicated grammar nodes like integer_atom_type, but a few
// user-style spellings slip through). A field of one of these is not a has-a
// relationship to a user class, so it never becomes a composition edge.
const SV_BUILTIN_TYPES = new Set([
  'int', 'integer', 'bit', 'logic', 'reg', 'byte', 'shortint', 'longint',
  'time', 'real', 'shortreal', 'realtime', 'string', 'chandle', 'event', 'void',
]);

/**
 * The user-class type of a `class_property` field, or undefined for a builtin /
 * untyped field. The type sits under one of two shapes: ordinary/qualified fields
 * nest it as `data_declaration -> data_type_or_implicit -> data_type` (the
 * data_declaration follows any leading rand/local/protected qualifier siblings,
 * so it is not at a fixed index); a `const` member exposes `data_type` as a direct
 * child of class_property. From data_type, the type identifier is read:
 *   - a `class_type` child joins its DIRECT simple_identifier children with `::`
 *     (so `pkg::base` keeps its scope, and a `#(param)` value assignment — which
 *     is a sibling, not a simple_identifier — is excluded: `port #(txn)` -> `port`).
 *   - otherwise a direct simple_identifier under data_type is the type name.
 *   - a builtin (`int` -> integer_atom_type, `string` -> empty) has no
 *     simple_identifier here, so this returns undefined and no edge is emitted.
 */
function fieldTypeName(classProperty: SyntaxNode, source: string): string | undefined {
  // Two field shapes carry the type differently:
  //   - ordinary/qualified fields nest it under a `data_declaration` (which
  //     itself may sit behind rand/local/protected sibling *_qualifier nodes,
  //     so it isn't at a fixed index — `rand local foo_t f;` puts it at 2);
  //   - a `const` member skips the wrapper entirely and exposes `data_type`
  //     as a direct child of class_property.
  // Find the data_type for either shape; qualifier nodes carry no type info.
  let dataType: SyntaxNode | undefined;
  for (let i = 0; i < classProperty.namedChildCount; i++) {
    const c = classProperty.namedChild(i);
    if (!c) continue;
    if (c.type === 'data_type') {
      dataType = c; // const-member form: class_property > data_type
      break;
    }
    if (c.type === 'data_declaration') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const d = c.namedChild(j);
        if (!d) continue;
        if (d.type === 'data_type_or_implicit') {
          for (let k = 0; k < d.namedChildCount; k++) {
            const e = d.namedChild(k);
            if (e && e.type === 'data_type') { dataType = e; break; }
          }
        } else if (d.type === 'data_type') {
          dataType = d;
        }
        if (dataType) break;
      }
      break;
    }
  }
  if (!dataType) return undefined;

  const first = dataType.namedChild(0);
  if (!first) return undefined; // e.g. `string` parses with no child here

  if (first.type === 'class_type') {
    const ids: string[] = [];
    for (let i = 0; i < first.namedChildCount; i++) {
      const c = first.namedChild(i);
      if (c && c.type === 'simple_identifier') ids.push(getNodeText(c, source).trim());
    }
    return ids.length > 0 ? ids.join('::') : undefined;
  }
  if (first.type === 'simple_identifier') return getNodeText(first, source).trim();

  // Builtin scalar/integer types (integer_atom_type, etc.) -> not a user type.
  return undefined;
}

/** The `name` field text of a method_call's method_call_body child, if any. */
function methodCallName(methodCall: SyntaxNode, source: string): string | undefined {
  for (let i = 0; i < methodCall.namedChildCount; i++) {
    const c = methodCall.namedChild(i);
    if (c && c.type === 'method_call_body') {
      const nm = getChildByField(c, 'name');
      if (nm) return getNodeText(nm, source).trim();
    }
  }
  return undefined;
}

/** The leading simple_identifier of the first hierarchical_identifier in a subtree. */
function firstHierId(node: SyntaxNode, source: string): string | undefined {
  const stack: SyntaxNode[] = [node];
  let guard = 0;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'hierarchical_identifier') {
      const id = cur.namedChild(0);
      if (id && id.type === 'simple_identifier') return getNodeText(id, source).trim();
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

/**
 * For a `T::type_id::create(...)` call, the created Type `T`. The outer
 * method_call is `create`; its receiver `primary` nests an inner method_call
 * named `type_id` whose own `primary > hierarchical_identifier` leads with the
 * base type id. Returns undefined unless a `type_id` link is actually present —
 * so a plain `obj.create()` (no factory) is not mistaken for a UVM create.
 */
function createTypeFromChain(createCall: SyntaxNode, source: string): string | undefined {
  // The receiver is the create call's primary child (not the method_call_body).
  let primary: SyntaxNode | undefined;
  for (let i = 0; i < createCall.namedChildCount; i++) {
    const c = createCall.namedChild(i);
    if (c && c.type === 'primary') { primary = c; break; }
  }
  if (!primary) return undefined;

  // Find the inner method_call (the `type_id` link) under that primary.
  const stack: SyntaxNode[] = [primary];
  let guard = 0;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'method_call' && methodCallName(cur, source) === 'type_id') {
      // Its own receiver primary leads with the base type identifier.
      for (let i = 0; i < cur.namedChildCount; i++) {
        const c = cur.namedChild(i);
        if (c && c.type === 'primary') return firstHierId(c, source);
      }
      return undefined;
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

/**
 * The assigned handle for a create call: walk up to the enclosing
 * operator_assignment (under blocking_assignment) and read the leading
 * identifier of its variable_lvalue. Empty when the create isn't assigned
 * (e.g. a bare `create(...)` statement). Capped so a deep nesting can't loop.
 */
function assignedHandle(createCall: SyntaxNode, source: string): string {
  for (let p = createCall.parent, depth = 0; p && depth < 24; p = p.parent, depth++) {
    if (p.type === 'operator_assignment' || p.type === 'blocking_assignment') {
      for (let i = 0; i < p.namedChildCount; i++) {
        const c = p.namedChild(i);
        if (c && c.type === 'variable_lvalue') {
          const h = firstHierId(c, source);
          if (h) return h;
        }
      }
      return '';
    }
  }
  return '';
}

/** Dotted segments of a hierarchical_identifier (`a.b.c` -> ['a','b','c']). */
function hierIdSegments(hierId: SyntaxNode, source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < hierId.namedChildCount; i++) {
    const c = hierId.namedChild(i);
    if (c && c.type === 'simple_identifier') out.push(getNodeText(c, source).trim());
  }
  return out;
}

/**
 * For a `a.b.connect(c.d)` statement, the (fromChain, toChain) dotted handle
 * paths — or undefined when the subroutine_call isn't a `.connect()`. The
 * subroutine_call wraps a `tf_call` whose hierarchical_identifier ends in
 * `connect`; the prefix is the from-chain and the first argument's
 * hierarchical_identifier is the to-chain.
 */
function connectChains(subroutineCall: SyntaxNode, source: string): { from: string; to: string } | undefined {
  let tfCall: SyntaxNode | undefined;
  for (let i = 0; i < subroutineCall.namedChildCount; i++) {
    const c = subroutineCall.namedChild(i);
    if (c && c.type === 'tf_call') { tfCall = c; break; }
  }
  if (!tfCall) return undefined;

  let hierId: SyntaxNode | undefined;
  let args: SyntaxNode | undefined;
  for (let i = 0; i < tfCall.namedChildCount; i++) {
    const c = tfCall.namedChild(i);
    if (!c) continue;
    if (c.type === 'hierarchical_identifier') hierId = c;
    else if (c.type === 'list_of_arguments') args = c;
  }
  if (!hierId) return undefined;

  const segs = hierIdSegments(hierId, source);
  if (segs.length < 2 || segs[segs.length - 1] !== 'connect') return undefined; // need prefix.connect
  const fromChain = segs.slice(0, -1).join('.');

  // The to-chain is the first argument's hierarchical_identifier.
  if (!args) return undefined;
  const stack: SyntaxNode[] = [args];
  let guard = 0;
  let toChain: string | undefined;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'hierarchical_identifier') {
      toChain = hierIdSegments(cur, source).join('.');
      break;
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  if (!toChain) return undefined;
  return { from: fromChain, to: toChain };
}

/** True when the subtree is an enum typedef, so it becomes an `enum` node not a type alias. */
function isEnumTypedef(node: SyntaxNode): boolean {
  const queue: SyntaxNode[] = [node];
  let guard = 0;
  while (queue.length && guard++ < 256) {
    const cur = queue.shift()!;
    if (cur.type === 'enum_name_declaration' || cur.type === 'enum_base_type') return true;
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (c) queue.push(c);
    }
  }
  return false;
}

// -- Signals: ports, nets, variables, parameters ------------------------------
//
// RTL work is signal work: "where is rstn_sync declared", "what is dft_mode",
// "which module owns cfg_mode" are the questions actually asked of a design.
// Before this the graph had no answer at all -- SV emitted modules, classes and
// subroutines only, so every signal-name query returned zero rows and the caller
// fell back to grepping and reading whole files.
//
// NODE_KINDS has no HDL-specific kind, so the two closest are reused:
//   ports + nets + variables  -> 'field'     (a member of the enclosing module)
//   parameter / localparam    -> 'constant'
// The RTL detail rides along in `decorators` (['input'] / ['wire'] / ['logic'])
// and `signature` (the collapsed declaration text), so search output still reads
// like RTL rather than a bare identifier.

/** Non-ANSI port declarations: `input clk;` / `output reg [7:0] q;`. */
const NONANSI_PORT_NODES = new Set([
  'input_declaration',
  'output_declaration',
  'inout_declaration',
]);

/**
 * Identifier-list wrappers under a non-ANSI port declaration. Which one appears
 * is decided by the declared TYPE, not the direction: a net or implicit type
 * gives list_of_port_identifiers, `output reg y` gives
 * list_of_variable_port_identifiers, an explicit `var` gives
 * list_of_variable_identifiers. All three hold N direct simple_identifier
 * children, so all three must be accepted or a whole declaration style is lost.
 */
const PORT_ID_LIST_NODES = new Set([
  'list_of_port_identifiers',
  'list_of_variable_port_identifiers',
  'list_of_variable_identifiers',
]);

/** ANSI port headers that can carry a direction keyword. */
const PORT_HEADER_NODES = new Set([
  'variable_port_header',
  'net_port_header',
  'interface_port_header',
]);

/** Direct named children of `node` with the given type. */
function childrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

/** First direct named child of `node` whose type is in `types`. */
function firstChildOfTypes(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && types.has(c.type)) return c;
  }
  return undefined;
}

/**
 * One-line signature for a signal declaration -- the declaration text with runs
 * of whitespace collapsed and a long initializer trimmed, so a search hit reads
 * `output [23:00] rx_wdata_l` instead of a bare name.
 */
function svDeclSignature(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).replace(/\s+/g, ' ').replace(/\s*;$/, '').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Direction of an ANSI port. SystemVerilog lets a port INHERIT the previous
 * port's direction -- in `module m(input logic a, b)` the `b` has no header
 * child at all -- so a headerless port walks back through its previous siblings
 * until one carries a direction. The first port of a list with no direction at
 * all defaults to `input`, matching the language rule.
 */
function ansiPortDirection(node: SyntaxNode, source: string): string {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.previousNamedSibling) {
    if (cur.type !== 'ansi_port_declaration') continue;
    const header = firstChildOfTypes(cur, PORT_HEADER_NODES);
    if (!header) continue;
    const dir = childrenOfType(header, 'port_direction')[0];
    if (dir) return getNodeText(dir, source).trim();
  }
  return 'input';
}

/**
 * Base type keyword of a variable declaration (`reg`, `logic`, `bit`, `int`, or
 * a user typedef name), used as the node's decorator. `var` when the type is
 * implicit.
 */
function svDataKindOf(node: SyntaxNode, source: string): string {
  const dt = childrenOfType(node, 'data_type_or_implicit')[0];
  const inner = dt ? childrenOfType(dt, 'data_type')[0] : undefined;
  if (!inner) return 'var';
  const first = getNodeText(inner, source).trim().split(/[\s[#]/)[0];
  return first || 'var';
}

/**
 * Emit one node per declared identifier. Position comes from the identifier
 * (so `wire a, b, c;` yields three nodes at three columns), while the signature
 * comes from the whole declaration.
 */
function emitSignalNodes(
  ids: readonly SyntaxNode[],
  decl: SyntaxNode,
  kind: NodeKind,
  decorator: string,
  ctx: ExtractorContext
): void {
  if (ids.length === 0) return;
  const signature = svDeclSignature(decl, ctx.source);
  for (const id of ids) {
    const name = getNodeText(id, ctx.source).trim();
    if (name) ctx.createNode(kind, name, id, { signature, decorators: [decorator] });
  }
}

/**
 * Blank Verilog/SystemVerilog conditional-compilation directive LINES
 * (`ifdef / `ifndef / `elsif / `else / `endif) before the grammar sees them.
 *
 * The grammar has no preprocessor, so a directive line is a syntax error, and
 * the ERROR node it produces swallows the rest of the enclosing module -- on a
 * real ASIC design that silently drops whole files from the index (a clock
 * module that switches between an `assign` and a cell instantiation on
 * `ifdef FPGA loses both to the ERROR).
 *
 * Removing only the directive lines keeps BOTH branches, which is the right
 * default for a code graph: an FPGA-only and an ASIC-only definition of the same
 * net are both facts an engineer may be asking about, and a graph that answers
 * "declared here and here" is strictly more useful than one that answers
 * "nothing found". Replacement preserves byte offsets (directive text ->
 * spaces, newlines kept) so every symbol's line/column stays exact.
 *
 * Only the directive TOKEN and its macro argument are blanked, NEVER the rest
 * of the line. Vendor models put live code after a directive on the same line:
 * a multi-line `if` condition that closes with "`endif  ) &&" is real, and
 * blanking to end-of-line ate the `) &&`, corrupting the expression and
 * killing every driver in the enclosing always block (seen on a vendor
 * memory model).
 *
 * `define / `include / `timescale and macro USES are left alone -- the grammar
 * parses those.
 */
export function blankVerilogConditionalDirectives(source: string): string {
  if (source.indexOf('`') === -1) return source;
  const blank = (m: string) => ' '.repeat(m.length);
  return (
    source
      // `ifdef FOO / `ifndef FOO / `elsif FOO -- directive plus its macro name.
      .replace(/^[ \t]*`(?:ifndef|ifdef|elsif)[ \t]+[A-Za-z_]\w*/gm, blank)
      // `else / `endif take no argument.
      .replace(/^[ \t]*`(?:else|endif)\b/gm, blank)
  );
}


// -- Drivers: who writes this net ---------------------------------------------
//
// "Where is rstn_sync declared" is answered by the signal nodes above; "what
// DRIVES it" is the other half of the same question, and the one an engineer
// asks when a net is stuck at the wrong value. The driver is the continuous
// assign or the always block that writes the signal, so the edge runs from the
// enclosing module to the signal, carrying the assignment's own line/column.
//
// Binding is deliberately MODULE-SCOPED, not name-matched: RTL reuses signal
// names ruthlessly (`cnt`, `valid`, `state` exist in a dozen modules), and a
// drive edge bound to the wrong module's `cnt` is worse than no edge at all.
// So the extractor emits a marker the generic resolver ignores, and the SV
// post-pass binds it against the module's own contained signals. A driven name
// the module does not declare -- an implicit net, or a testbench hierarchical
// reference like `dut.core.rstn` -- binds to nothing and is dropped.
const SV_DRIVE_PREFIX = '__sv_drive__';

/** Lvalue wrappers that can nest (concatenation targets: `{c, x} = din;`). */
const LVALUE_WRAPPERS = new Set(['net_lvalue', 'variable_lvalue']);

/**
 * Identifiers actually DRIVEN by an lvalue.
 *
 * Three shapes have to be told apart, and two of them are traps:
 *   - a concatenation lvalue nests further lvalues, so it must recurse or the
 *     driven names come back as the literal text `{c, x}`
 *   - a bit/part select (`dout[idx]`) hangs the index under a `constant_select`
 *     / `select` sibling, whose identifiers are READ, never driven -- so those
 *     subtrees are skipped rather than walked
 *   - `variable_lvalue` always nests its identifier under a
 *     `hierarchical_identifier`; `net_lvalue` never does
 *
 * A hierarchical reference with more than one segment (`dut.core.rstn`) is
 * skipped: its target lives in another module, which module-scoped binding
 * cannot reach, and guessing by last segment would invent edges.
 */
function collectDrivenIds(node: SyntaxNode, out: SyntaxNode[], depth = 0): void {
  if (depth > 8) return; // concat nesting is shallow in practice; bound the walk
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'simple_identifier') {
      out.push(c);
    } else if (LVALUE_WRAPPERS.has(c.type)) {
      collectDrivenIds(c, out, depth + 1);
    } else if (c.type === 'hierarchical_identifier') {
      const ids = childrenOfType(c, 'simple_identifier');
      if (ids.length === 1 && ids[0]) out.push(ids[0]);
    }
    // Anything else (constant_select, select, expression) is index or
    // right-hand-side material: read, not driven.
  }
}

/** Emit one drive marker per identifier the lvalue writes, at the site's position. */
function emitDriveMarkers(lvalue: SyntaxNode, site: SyntaxNode, ctx: ExtractorContext): void {
  const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromId) return;
  const ids: SyntaxNode[] = [];
  collectDrivenIds(lvalue, ids);
  if (ids.length === 0) return;
  const line = site.startPosition.row + 1;
  const column = site.startPosition.column;
  for (const id of ids) {
    const name = getNodeText(id, ctx.source).trim();
    if (!name) continue;
    ctx.addUnresolvedReference({
      fromNodeId: fromId,
      referenceName: `${SV_DRIVE_PREFIX}${name}`,
      referenceKind: 'drives',
      line,
      column,
    });
  }
}

// module/program are structural containers we model as 'module'; package -> 'namespace'.
const MODULE_NODES = new Set(['module_declaration', 'program_declaration']);

export const systemverilogExtractor: LanguageExtractor = {
  preParse: blankVerilogConditionalDirectives,
  // Subroutines. function/task are dual-listed in methodTypes (gated by
  // methodScopeKinds below) so they read as 'method' inside a class but stay
  // 'function' inside a module. class_constructor_declaration ('function new')
  // is method-only — it never appears outside a class.
  functionTypes: ['function_declaration', 'task_declaration'],
  methodTypes: ['function_declaration', 'task_declaration', 'class_constructor_declaration'],
  // A subroutine is a method only inside a class scope, not a module.
  methodScopeKinds: ['class'],
  // UVM / OOP classes use the engine's class machinery directly.
  classTypes: ['class_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: ['type_declaration'],
  importTypes: ['include_compiler_directive'],
  callTypes: ['tf_call'], // function/task subroutine calls -> 'calls' edges
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body', // SV has no 'body' field; extract* falls back to the node itself
  paramsField: 'tf_port_list',

  resolveName: (node, source) => svName(node, source),

  // SV functions/tasks keep statements under a *_body_declaration child (no 'body'
  // field); point the engine's body walk there or internal subroutine calls are lost.
  resolveBody: (node) => {
    if (node.type === 'function_declaration' || node.type === 'task_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && /_body_declaration$/.test(c.type)) return c;
      }
    }
    // The constructor has no *_body_declaration wrapper; walk the whole node so
    // calls in its body (super.new, helper calls) are still captured.
    if (node.type === 'class_constructor_declaration') return node;
    return null;
  },

  // Out-of-class definitions (`function void D::foo();`, `task D::run();`,
  // `function D::new();`) carry a `class_scope` naming the owning class — the
  // engine then extracts them as methods of D (qualified name + contains edge),
  // matching how Go/Rust receivers work. Inline definitions have no class_scope,
  // so this returns undefined and they follow the normal scope-based path.
  getReceiverType: (node, source) => {
    // function/task keep the class_scope under their *_body_declaration; the
    // constructor keeps it as a direct child.
    let container = node;
    if (node.type !== 'class_constructor_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && /_body_declaration$/.test(c.type)) {
          container = c;
          break;
        }
      }
    }
    for (let i = 0; i < container.namedChildCount; i++) {
      const c = container.namedChild(i);
      if (c && c.type === 'class_scope') {
        const classType = c.namedChild(0); // class_scope > class_type > simple_identifier(s)
        if (!classType) return undefined;
        const ids: SyntaxNode[] = [];
        for (let j = 0; j < classType.namedChildCount; j++) {
          const id = classType.namedChild(j);
          if (id && id.type === 'simple_identifier') ids.push(id);
        }
        const last = ids[ids.length - 1]; // qualified pkg::D -> the class is the last id
        if (last) return getNodeText(last, source).trim();
      }
    }
    return undefined;
  },

  extractImport: (node, source) => {
    // Only `include "file" is handled here; package imports are emitted in the
    // visitNode hook so a multi-package statement (`import a::*, b::x;`) yields
    // one import per package rather than just the first.
    const signature = getNodeText(node, source).trim();
    const m = signature.match(/["<]([^">]+)[">]/); // `include "defs.svh"
    return m && m[1] ? { moduleName: m[1], signature } : null;
  },

  // `super.m()` / `this.m()` parse as `method_call > implicit_class_handle +
  // method_call_body{name}` — distinct from a named-handle `obj.m()`, which is a
  // `tf_call` already covered by callTypes. The engine can't resolve these from a
  // flat name (the receiver is implicit), so we surface a `this.<m>`/`super.<m>`
  // marker ref and let the SV inheritance-chain pass bind it. `super.` must reach
  // the PARENT class's `m`, never the caller's own — hence the handle is preserved
  // in the ref name rather than collapsed to the bare method here.
  //
  // This runs for every body node that isn't a tf_call, so it must be strict:
  // only a method_call whose first named child is an implicit_class_handle
  // qualifies; everything else returns undefined and is left untouched.
  extractBareCall: (node, source) => {
    if (node.type === 'method_call') {
      const handle = node.namedChild(0);

      // this./super. dispatch: implicit_class_handle receiver.
      if (handle && handle.type === 'implicit_class_handle') {
        // The handle text is `this`, `super`, or `this.super`; only `super`-bearing
        // forms walk up the extends chain — the rest resolve from the enclosing class.
        const receiver = getNodeText(handle, source).includes('super') ? 'super' : 'this';
        const methodName = methodCallName(node, source);
        return methodName ? `${receiver}.${methodName}` : undefined;
      }

      // UVM factory create: `h = T::type_id::create("h", this)`. The outer call
      // is `create`; its receiver chain carries the `type_id` link and the base
      // type. We can't resolve the LHS handle -> component class from the flat
      // name here (the class graph isn't built yet), so emit a marker carrying
      // the handle and the created Type; a post-pass binds it once the graph
      // exists. Guard on a real type_id link so plain `obj.create()` is ignored.
      if (methodCallName(node, source) === 'create') {
        const type = createTypeFromChain(node, source);
        if (type) {
          const handleName = assignedHandle(node, source); // '' when not assigned
          // Separate the handle and type with `|`, not `__`: a double underscore
          // is a legal SV identifier substring (`cfg__db`), so splitting the
          // body on `__` would mangle such names. A pipe can't occur in an
          // identifier or a dotted chain, so it splits unambiguously.
          return `__sv_create__${handleName}|${type}`;
        }
      }
      return undefined;
    }

    // TLM dataflow: `a.b.connect(c.d)`. The subroutine_call wraps a tf_call whose
    // hierarchical_identifier ends in `connect`. The handle chains can't be
    // resolved to component classes until the create-map exists, so emit a
    // marker with both dotted chains for the post-pass. (The inner tf_call still
    // emits a harmless unresolved `connect` call — dropped during resolution.)
    if (node.type === 'subroutine_call') {
      const chains = connectChains(node, source);
      // `|` separates the two dotted chains (see the create marker above for why
      // `__` is unsafe); dots stay as the in-chain token separator.
      if (chains) return `__sv_connect__${chains.from}|${chains.to}`;
      return undefined;
    }

    return undefined;
  },

  /**
   * The engine's list-driven dispatch can only emit class/struct/enum/interface/trait,
   * never 'module', and module instantiation isn't a call expression — so the structural
   * containers and the design-hierarchy edges are created here.
   */
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const t = node.type;

    // Enum typedefs: the engine's type-alias path can't emit enum members (it
    // looks for enumTypes, which SV leaves empty), so build the enum + members here.
    if (t === 'type_declaration' && isEnumTypedef(node)) {
      const name = svName(node, ctx.source);
      if (!name) return false;
      const enumNode = ctx.createNode('enum', name, node);
      if (!enumNode) return true;
      ctx.pushScope(enumNode.id);
      const q: SyntaxNode[] = [node];
      let guard = 0;
      while (q.length && guard++ < 512) {
        const cur = q.shift()!;
        if (cur.type === 'enum_name_declaration') {
          const mn = svName(cur, ctx.source);
          if (mn) ctx.createNode('enum_member', mn, cur);
          continue;
        }
        for (let i = 0; i < cur.namedChildCount; i++) {
          const c = cur.namedChild(i);
          if (c) q.push(c);
        }
      }
      ctx.popScope();
      return true;
    }

    // Package imports: one import node + `imports` ref per package_import_item,
    // so `import a::*, b::x;` produces both. (The engine's single-ImportInfo path
    // would only surface the first.)
    if (t === 'package_import_declaration') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const line = node.startPosition.row + 1;
      const column = node.startPosition.column;
      for (let i = 0; i < node.namedChildCount; i++) {
        const item = node.namedChild(i);
        if (!item || item.type !== 'package_import_item') continue;
        let pkg: string | undefined;
        for (let j = 0; j < item.namedChildCount; j++) {
          const c = item.namedChild(j);
          if (c && c.type === 'simple_identifier') {
            pkg = getNodeText(c, ctx.source).trim(); // leading id is the package name
            break;
          }
        }
        if (!pkg) continue;
        const imp = ctx.createNode('import', pkg, item);
        if (imp && fromId) {
          ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: pkg, referenceKind: 'imports', line, column });
        }
      }
      return true;
    }

    if (MODULE_NODES.has(t) || t === 'package_declaration') {
      const kind: NodeKind = t === 'package_declaration' ? 'namespace' : 'module';
      const name = svName(node, ctx.source);
      if (!name) return false; // malformed -> let default dispatch try
      const created = ctx.createNode(kind, name, node);
      if (!created) return true;
      ctx.pushScope(created.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
      return true; // fully handled
    }

    if (t === 'module_instantiation') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const typeName = instantiatedType(node, ctx.source); // bind to the module type, not the u_xxx label
      if (fromId && typeName) {
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        // `instantiates` is the semantically-correct edge for the design hierarchy.
        // We also emit `calls` so the call-graph commands (callers/callees) surface
        // instantiation — "who instantiates this module" is the RTL analog of "who
        // calls this function", and `impact` already walks both.
        // Known limit: callers/callees traverse `calls` globally (every language), so
        // we keep the `calls` edge rather than rewiring that path. If a project has
        // BOTH a module and a subroutine of the same name, the `calls` edge can
        // mis-bind to the subroutine; the `instantiates` edge prefers `module` via the
        // name-matcher bias, but a same-file subroutine can still outscore it. Rare in RTL.
        ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'instantiates', line, column });
        ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'calls', line, column });
      }
      return false; // keep walking: port-connection expressions may contain calls
    }

    // Class fields of a user-class type are the has-a topology of a UVM
    // testbench (env has-an agent, agent has-a driver, ...). Emit a
    // `references` edge class->field-type so callers/callees/impact surface it
    // (those traversals already include `references`); the resolver binds the
    // type name to the class via the normal name/qualified-name match. We point
    // the edge at the class, not a field node — callees doesn't walk `contains`,
    // so a class->field->type chain would never surface.
    if (t === 'class_property') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const typeName = fieldTypeName(node, ctx.source);
      if (fromId && typeName && !SV_BUILTIN_TYPES.has(typeName)) {
        // Walk up to the enclosing class_declaration: it both confirms a real
        // class context (not just whatever sits on nodeStack) and gives the
        // name needed to drop self-pointers (`uvm_component parent;` inside
        // uvm_component) — a class referencing itself is noise in a has-a graph.
        let enclosingClass: SyntaxNode | undefined;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'class_declaration') { enclosingClass = p; break; }
        }
        const enclosingClassName = enclosingClass ? svName(enclosingClass, ctx.source) : undefined;
        if (enclosingClass && typeName !== enclosingClassName) {
          const line = node.startPosition.row + 1;
          const column = node.startPosition.column;
          ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'references', line, column });
        }
      }
      return false; // keep walking: a field initializer may contain calls
    }

    // ANSI port list: `module m(input logic clk, output reg [7:0] q);`.
    // Anchor on the `port_name` FIELD, never on the header child -- a
    // direction-inheriting port (`input logic a, b` -> the `b`) has no header
    // at all and would be dropped silently.
    if (t === 'ansi_port_declaration') {
      const id = getChildByField(node, 'port_name');
      if (id) emitSignalNodes([id], node, 'field', ansiPortDirection(node, ctx.source), ctx);
      return false; // keep walking: a default value can contain a call
    }

    // Non-ANSI port declarations: `input clk;` / `output reg [7:0] q;`. The
    // bare name list in the header (`module n(a, b, y);`) is deliberately NOT
    // extracted -- these declarations carry direction and type, and the header
    // list would only duplicate them.
    if (NONANSI_PORT_NODES.has(t)) {
      const list = firstChildOfTypes(node, PORT_ID_LIST_NODES);
      const ids = list ? childrenOfType(list, 'simple_identifier') : [];
      emitSignalNodes(ids, node, 'field', t.replace('_declaration', ''), ctx);
      return false;
    }

    // Nets: `wire [3:0] cnt;`, `tri sda;`. Note `reg`/`logic`/`bit` are NOT
    // nets in this grammar -- they parse as data_declaration, handled below.
    if (t === 'net_declaration') {
      const list = childrenOfType(node, 'list_of_net_decl_assignments')[0];
      const ids: SyntaxNode[] = [];
      if (list) {
        for (const a of childrenOfType(list, 'net_decl_assignment')) {
          const id = childrenOfType(a, 'simple_identifier')[0]; // bare id, no field name
          if (id) ids.push(id);
        }
      }
      const netType = childrenOfType(node, 'net_type')[0];
      emitSignalNodes(ids, node, 'field', netType ? getNodeText(netType, ctx.source).trim() : 'net', ctx);
      // `wire drv = a & b;` declares AND drives: the assignment node carries an
      // expression child alongside the identifier.
      if (list) {
        for (const a of childrenOfType(list, 'net_decl_assignment')) {
          const id = childrenOfType(a, 'simple_identifier')[0];
          if (id && a.namedChildCount > 1) emitDriveMarkers(a, a, ctx);
        }
      }
      return false;
    }

    // Variables: `reg valid;`, `logic [31:0] data_q;`, and class properties.
    // A typedef is ALSO a data_declaration (via type_declaration) and is already
    // extracted through typeAliasTypes -- skip it here or it doubles as a field.
    if (t === 'data_declaration') {
      if (childrenOfType(node, 'type_declaration').length > 0) return false;
      const list = childrenOfType(node, 'list_of_variable_decl_assignments')[0];
      const ids: SyntaxNode[] = [];
      if (list) {
        for (const a of childrenOfType(list, 'variable_decl_assignment')) {
          const id = getChildByField(a, 'name'); // variables use a `name` field; nets do not
          if (id) ids.push(id);
        }
      }
      emitSignalNodes(ids, node, 'field', svDataKindOf(node, ctx.source), ctx);
      return false;
    }

    // parameter / localparam. Both the `#(...)` parameter port list and the
    // module body nest the same inner shape, so one unanchored match covers
    // both; localparam is a SEPARATE node type and must be named explicitly.
    if (t === 'parameter_declaration' || t === 'local_parameter_declaration') {
      const list = childrenOfType(node, 'list_of_param_assignments')[0];
      const ids: SyntaxNode[] = [];
      if (list) {
        for (const a of childrenOfType(list, 'param_assignment')) {
          const id = childrenOfType(a, 'simple_identifier')[0];
          if (id) ids.push(id);
        }
      }
      const decorator = t === 'local_parameter_declaration' ? 'localparam' : 'parameter';
      emitSignalNodes(ids, node, 'constant', decorator, ctx);
      return false;
    }

    // Continuous assign: `assign y = a & b;` — the module drives y.
    if (t === 'continuous_assign') {
      const list = childrenOfType(node, 'list_of_net_assignments')[0];
      const assigns = list
        ? childrenOfType(list, 'net_assignment')
        : childrenOfType(node, 'net_assignment');
      for (const a of assigns) {
        const lv = childrenOfType(a, 'net_lvalue')[0];
        if (lv) emitDriveMarkers(lv, a, ctx);
      }
      return false; // keep walking: the right-hand side can contain calls
    }

    // Sequential driver: `q <= d;` inside always_ff / always @(posedge clk).
    // Matched unanchored — the statement nesting between the always keyword and
    // the assignment differs between the begin/end and single-statement forms,
    // so any fixed-depth path would miss half of them.
    if (t === 'nonblocking_assignment') {
      const lv = childrenOfType(node, 'variable_lvalue')[0];
      if (lv) emitDriveMarkers(lv, node, ctx);
      return false;
    }

    // Combinational driver: `p = a;` inside always_comb / always @(*) / initial.
    // The `operator_assignment` layer is mandatory — a variable_lvalue is never
    // a direct child of blocking_assignment.
    if (t === 'blocking_assignment') {
      const op = childrenOfType(node, 'operator_assignment')[0];
      const lv = op
        ? childrenOfType(op, 'variable_lvalue')[0]
        : childrenOfType(node, 'variable_lvalue')[0];
      if (lv) emitDriveMarkers(lv, node, ctx);
      return false;
    }

    return false;
  },
};
