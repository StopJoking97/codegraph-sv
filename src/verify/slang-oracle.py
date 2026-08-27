"""Independent SystemVerilog declaration oracle for `codegraph verify`.

Runs as a CHILD PROCESS of the verify pass. Reads a JSON job on stdin, writes a
JSON report on stdout, and never writes anything else to stdout — stderr carries
diagnostics.

It GRADES; it never extracts and it never removes a node. CodeGraph's own
extraction stays tree-sitter-based and continues to index the union of all
conditional-compilation branches, because a code-intelligence tool must be able
to find code in a branch that is not currently compiled. This oracle exists to
say where the two disagree, not to replace either.

Protocol
--------
stdin (JSON):
  {
    "protocol":    1,
    "root":        "<absolute project root>",
    "files":       ["rtl/a.sv", ...],   # project-root-relative, ALREADY SCOPED
    "includeDirs": ["rtl/include", ...],# project-root-relative
    "defines":     {"NAME": "value"}
  }

stdout (JSON):
  {
    "protocol":  1,
    "oracle":    "pyslang",
    "version":   "11.0.0",
    "mode":      "preprocessed" | "syntax-only",
    "notes":     ["...", ...],          # what could not be applied, verbatim
    "files":     {"<rel>": {"scope": [...], "local": [...]}},
    "parseFailed": ["<rel>", ...],
    "notOnDisk":   ["<rel>", ...]
  }

`scope` holds declarations at module/class/package level. `local` holds
declarations inside a subroutine or procedural block; CodeGraph deliberately
does not index those (an identifier that dies at its block's end is neither
probeable, connectable nor driveable), so the two are reported separately and
the caller must never fold them together.

Exit codes: 0 on success, 2 when pyslang is not importable (the caller degrades
to a printed skip), 3 on a malformed job.
"""

import json
import os
import sys

PROTOCOL = 1

# A `Declarator` is the name in `logic [7:0] foo;`. The header kinds cover the
# named constructs whose identifier is not a Declarator.
#
# `FunctionPrototype` is where BOTH a function's and a task's name lives (slang
# gives a task a FunctionPrototype whose keyword is `task`). It is also the one
# kind whose `name` is a SyntaxNode rather than a Token, which is why name
# reading below handles both shapes — reading only `.valueText` silently dropped
# every subroutine name and made the classifier's UNEXPLAINED tripwire fire on
# tasks the index had correctly indexed.
#
# Package, interface and program headers, and typedefs, are here for the same
# reason: CodeGraph indexes all four (package -> namespace, interface ->
# interface, program -> module, typedef -> type_alias/enum), so leaving them out
# of the oracle understated the denominator — those names could never be scored
# MISSING, and on the index side they landed in UNEXPLAINED or were absorbed by
# BRANCH-UNION inside include guards. Grading a population smaller than the one
# the index actually serves is the failure this whole pass exists to prevent.
DECL_KINDS = {"SyntaxKind.Declarator"}
HEADER_KINDS = {
    "SyntaxKind.ModuleHeader",
    "SyntaxKind.ClassDeclaration",
    "SyntaxKind.FunctionPrototype",
    "SyntaxKind.PackageHeader",
    "SyntaxKind.InterfaceHeader",
    "SyntaxKind.ProgramHeader",
    "SyntaxKind.TypedefDeclaration",
}

# A subroutine's OWN name is design scope even though everything declared inside
# it is procedural-local — so the locality walk starts ABOVE the declaration that
# a prototype names, not at it.
PROTOTYPE_KIND = "SyntaxKind.FunctionPrototype"

# Scopes whose declarations die at the block's end. CodeGraph excludes these by
# design, so grading has to be able to tell them apart from design scope.
LOCAL_SCOPES = {
    "SyntaxKind.FunctionDeclaration",
    "SyntaxKind.TaskDeclaration",
    "SyntaxKind.SequentialBlockStatement",
    "SyntaxKind.ParallelBlockStatement",
    "SyntaxKind.InitialBlock",
    "SyntaxKind.AlwaysBlock",
    "SyntaxKind.FinalBlock",
    "SyntaxKind.ForLoopStatement",
    "SyntaxKind.ForeachLoopStatement",
}


def fail(code, message):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 — any malformed job is the same failure
        fail(3, "could not parse job JSON: %s" % exc)

    if job.get("protocol") != PROTOCOL:
        fail(3, "unsupported protocol %r (this oracle speaks %d)" % (job.get("protocol"), PROTOCOL))

    try:
        import pyslang
        from pyslang.syntax import SyntaxTree
    except Exception as exc:  # noqa: BLE001
        fail(2, "pyslang is not importable: %s" % exc)

    version = getattr(pyslang, "__version__", "unknown")
    root = job["root"]
    files = job.get("files") or []
    include_dirs = [os.path.join(root, d.replace("/", os.sep)) for d in (job.get("includeDirs") or [])]
    defines = job.get("defines") or {}

    # Include directories are applied through a SourceManager, which is the only
    # preprocessor lever pyslang 11 exposes to Python: it has a `Bag` with a
    # `preprocessorOptions` slot but no constructible options class behind it, so
    # DEFINES cannot be injected at all. Say so in the report rather than
    # pretending the run was fully preprocessed — a verify pass that overstates
    # its own rigour is worse than one that grades loosely and admits it.
    source_manager = None
    mode = "syntax-only"
    notes = []
    if include_dirs:
        try:
            source_manager = pyslang.SourceManager()
            for d in include_dirs:
                source_manager.addUserDirectories(d)  # one path per call in 11.x
            mode = "preprocessed"
        except Exception as exc:  # noqa: BLE001
            notes.append("include directories could not be applied (%s); graded syntax-only" % exc)
            source_manager = None
            mode = "syntax-only"
    if defines:
        notes.append(
            "pyslang %s exposes no way to predefine macros from Python, so %d define(s) were NOT applied"
            % (version, len(defines))
        )

    out_files = {}
    parse_failed = []
    not_on_disk = []

    for rel in files:
        abspath = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.exists(abspath):
            not_on_disk.append(rel)
            continue
        try:
            if source_manager is not None:
                tree = SyntaxTree.fromFile(abspath, source_manager, pyslang.Bag())
            else:
                tree = SyntaxTree.fromFile(abspath)
        except Exception:  # noqa: BLE001
            parse_failed.append(rel)
            continue
        if tree is None:
            parse_failed.append(rel)
            continue

        scope = set()
        local = set()

        def is_local(node, skip_own_declaration=False):
            parent = getattr(node, "parent", None)
            # A prototype's parent IS the Function/TaskDeclaration it names, and
            # that declaration is a local SCOPE — but the subroutine's own name
            # belongs to the module around it, so step over exactly one level.
            if skip_own_declaration and parent is not None:
                parent = getattr(parent, "parent", None)
            while parent is not None:
                if str(getattr(parent, "kind", "")) in LOCAL_SCOPES:
                    return True
                parent = getattr(parent, "parent", None)
            return False

        def name_of(node):
            """The declared identifier, whether `name` is a Token or a SyntaxNode."""
            raw = getattr(node, "name", None)
            if raw is None:
                return None
            text = getattr(raw, "valueText", None)
            if text:
                return text
            # FunctionPrototype hands back an IdentifierName node.
            text = str(raw).strip()
            return text or None

        def visit(node, _s=scope, _l=local):
            kind = str(getattr(node, "kind", ""))
            if kind in DECL_KINDS or kind in HEADER_KINDS:
                name = name_of(node)
                if name:
                    if is_local(node, skip_own_declaration=(kind == PROTOTYPE_KIND)):
                        _l.add(name)
                    else:
                        _s.add(name)

        try:
            tree.root.visit(visit)
        except Exception:  # noqa: BLE001
            parse_failed.append(rel)
            continue

        out_files[rel] = {"scope": sorted(scope), "local": sorted(local)}

    json.dump(
        {
            "protocol": PROTOCOL,
            "oracle": "pyslang",
            "version": version,
            "mode": mode,
            "notes": notes,
            "files": out_files,
            "parseFailed": parse_failed,
            "notOnDisk": not_on_disk,
        },
        sys.stdout,
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
