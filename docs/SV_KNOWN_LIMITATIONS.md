# SystemVerilog support — known limitations

**Status as of 2026-08-27** (`main` @ `1da960d` + this note) · Applies to the SV graph completion
work merged across `9005cbc..1da960d`.

**Fitness verdict:** the SV graph is fit for querying design structure and drivers. The four
defects that could produce a *wrong* answer are closed and regression-tested. What remains is a
named blind spot in extraction, and one reporting tool that is not yet CI-ready. Both are
enumerated below so a reader knows the edge of the map rather than discovering it by being wrong.

---

## 1. Reads and drives inside subroutine bodies are not extracted

**What is missing.** References to module-level signals from inside a `function` or `task` body
produce no `reads` edge, no `drives` edge, and no `hier_ref` edge. A hierarchical backdoor write
of the UVM kind:

```systemverilog
task automatic reset_dut();
  top_dut.u_core.u_leaf.state = 8'h0;   // <-- invisible to the graph
endtask
```

is absent from the driver answer entirely. The claim that "sensitivity-list, condition,
index... reads are all captured" holds only *outside* subroutine scopes.

**Cause.** The per-node language hook that emits SV markers runs from the main tree walk, but not
from `visitForCallsAndStructure` (`src/extraction/tree-sitter.ts`), which is the traversal that
descends into subroutine bodies. Markers that would be emitted there never exist, so the
resolution passes in `src/resolution/index.ts` have nothing to bind.

**Where it bites.** Synthesizable RTL rarely declares a `task` or `function`; behavioral
models, bus-functional models and vendor memory models often do. Files without a subroutine are
unaffected. The gap concentrates in behavioral and vendor models, which is where the answer should
be treated as incomplete.

**Workaround.** For driver questions inside a behavioral model, fall back to `grep`. The graph
returning no driver for a signal written only from a task body is a *silent* miss, not an error —
that is the property this note exists to make non-silent.

**Deliberate boundary, not a defect:** procedural locals (variables declared inside a subroutine
or block) are never indexed, in any language the engine supports. `verify`'s classifier excludes
them on both sides, so they do not appear as false MISSINGs.

---

## 2. `codegraph verify --strict` is not ready for CI when `includeDirs` is set

**Symptom.** In preprocessed mode — the configuration the verify report
itself recommends — slang attributes declarations pulled in by an `` `include `` to the
*including* file. The index attributes them to the header where they are written. Every such name
is then reported MISSING and `--strict` fails a correct index.

**Consequence.** `--strict` is correct on a project with no `verify.includeDirs`, and noisy on one
that has it. Do not wire it into CI until this is closed, or it will train reviewers to ignore it.

**Related, still open:** slang's error recovery means real parse damage never reaches
`parseFailed`, so a file can be graded while only partly parsed — the graded population shrinks
per file while the score stays at 100%. The `minCoverage` gate added in this cycle catches a
shortfall in the graded FILE count, but not a hole *inside* a file that was counted.

**What is safe today.** `codegraph verify` without `--strict` reports accurately and is useful for
eyeballing coverage. `--strict` on a project without `includeDirs` is a valid gate.

---

## 3. Reserved identifier prefix

`__sv_` is reserved for internal SystemVerilog resolution markers. Do not introduce nodes, edge
metadata keys, or symbol names with that prefix — the SV post-passes consume and delete them.

---

## Re-index requirement

`EXTRACTION_VERSION` is `26`. An index stamped below that is stale and will not contain the SV
edge kinds in their current form. `codegraph` reports this; the fix is a **full** `codegraph index`
from inside the project root, not `sync`.

Incremental `sync` now runs the SV post-passes, so day-to-day edits no longer drop
`drives`/`connects`/`reads` edges. That was fixed in `1da960d` and is regression-tested.

---

## Correction to an earlier count in this document's first revision

An earlier revision said exactly one open finding changes what the graph *contains*. **It is at
least two.** `[extraction 4]` fabricates port direction for a headerless first ANSI port and for
interface ports, and direction picks the `connects` arrow orientation — so it can produce an edge
pointing the wrong way, not merely a reporting inaccuracy.

Exposure: the interface-port half fires only on a design that declares `interface` ports. The
headerless-ANSI half is **unquantified**: separating it from Verilog-1995 non-ANSI port lists, a
different code path, has not been measured. Until it is, treat `connects` arrow direction on
modules with headerless ANSI or interface ports as unverified. `drives` is unaffected.

## Where the full finding list lives

- Tracked as issues #1–#8 of this repository.

Of the 21 findings open at the time of writing, **two** — item 1 above and `[extraction 4]` — can
change what the graph *contains*. The other 19 change what `verify` *reports*, or are robustness,
residual, and documentation-accuracy work, and cannot produce a wrong edge.
