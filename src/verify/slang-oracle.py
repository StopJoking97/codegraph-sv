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

Every name is filed under the file whose TEXT declares it, resolved through
slang's SourceManager -- NOT under the file being parsed when it was found. An
`include`-d header's declarations therefore belong to the header, matching how
the index attributes them. A declaration whose origin file was not in `files`
is reported nowhere and counted in `notes`.

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
    # The formals of `covergroup cg with function sample(int a, ...)` are local
    # to the covergroup; the index does not carry them, as for any subroutine.
    "SyntaxKind.CovergroupDeclaration",
}

# -- Statement fragments ------------------------------------------------------
#
# A file holding a bare statement list is meant to be `include-d inside a
# procedural block; standalone it is not a compilation unit, and slang and the
# index recover from it differently (slang reads a procedural `for` as a
# generate loop and promotes its locals to design scope, and skips a
# `fork ... join` region as bad tokens). Such a file is reported as a FRAGMENT
# and graded loosely, visibly. Three tests, all required:
#   1. the compilation unit holds no declaration container,
#   2. slang reported a member-level complaint (NotAllowedInCU / ExpectedMember),
#   3. the same text wrapped in `initial begin ... end` parses with strictly
#      fewer errors -- it reads as statements. A header of module items (`wire`,
#      `assign`) parses WORSE when wrapped, so it stays strictly graded.
CONTAINER_KINDS = {
    "SyntaxKind.ModuleDeclaration",
    "SyntaxKind.PackageDeclaration",
    "SyntaxKind.InterfaceDeclaration",
    "SyntaxKind.ProgramDeclaration",
    "SyntaxKind.ClassDeclaration",
    "SyntaxKind.CheckerDeclaration",
}
FRAGMENT_DIAGS = {"NotAllowedInCU", "ExpectedMember"}
FRAGMENT_WRAP_HEAD = "module __codegraph_fragment__; initial begin\n"
FRAGMENT_WRAP_TAIL = "\nend endmodule\n"


def error_codes(tree):
    """Short names of the error-severity diagnostics of a tree."""
    out = []
    for d in getattr(tree, "diagnostics", []) or []:
        try:
            if not d.isError():
                continue
        except Exception:  # noqa: BLE001
            pass
        code = str(getattr(d, "code", ""))
        # "DiagCode(NotAllowedInCU)" -> "NotAllowedInCU"
        if code.startswith("DiagCode(") and code.endswith(")"):
            code = code[len("DiagCode("):-1]
        out.append(code)
    return out


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
    #
    # Each directory is applied INDEPENDENTLY. They used to share one try, so a
    # single unusable path -- a stale entry in codegraph.json, a directory that
    # only exists on another machine -- threw on the first bad one and
    # abandoned every good one with it. The run then graded syntax-only, found
    # no cross-file declaration, reported zero MISSING and exited 0: a strictly
    # weaker run presented as a clean pass. One bad path must cost only itself.
    source_manager = None
    mode = "syntax-only"
    notes = []
    if include_dirs:
        try:
            source_manager = pyslang.SourceManager()
        except Exception as exc:  # noqa: BLE001
            notes.append("a SourceManager could not be created (%s); graded syntax-only" % exc)
            source_manager = None
        if source_manager is not None:
            applied = 0
            for d in include_dirs:
                try:
                    source_manager.addUserDirectories(d)  # one path per call in 11.x
                    applied += 1
                except Exception as exc:  # noqa: BLE001
                    notes.append("include directory could not be applied: %s (%s)" % (d, exc))
            if applied > 0:
                mode = "preprocessed"
            else:
                # Nothing resolved, so the manager buys nothing and its presence
                # would only make the mode field lie.
                notes.append("no configured include directory could be applied; graded syntax-only")
                source_manager = None
    if defines:
        notes.append(
            "pyslang %s exposes no way to predefine macros from Python, so %d define(s) were NOT applied"
            % (version, len(defines))
        )

    # -- Origin routing --------------------------------------------------------
    #
    # A declaration belongs to the file whose TEXT declares it, never to
    # whichever file happened to pull it in.
    #
    # In preprocessed mode -- the configuration this pass itself recommends --
    # slang splices an `include`-d header into the including file's token
    # stream, so every name a header declared was reported as the INCLUDER's.
    # The index attributes those names to the header, correctly, and the two
    # then disagreed on every one of them: a correct index failed --strict with
    # one MISSING per included declaration, which in practice means teams turn
    # the gate off. slang knew the answer all along -- each token carries a
    # SourceLocation whose buffer IS the origin file -- it was simply never
    # asked.
    #
    # This is NOT preprocessed-only. A relative `include` resolves against the
    # including file's own directory even with no user directories configured,
    # so syntax-only mode misattributes exactly the same way; it is routed
    # through the tree's own SourceManager rather than being left alone.
    FOREIGN = object()

    requested_by_path = {}
    for rel in files:
        try:
            key = os.path.normcase(os.path.realpath(os.path.join(root, rel.replace("/", os.sep))))
        except Exception:  # noqa: BLE001
            continue
        requested_by_path[key] = rel

    path_cache = {}

    def origin_of(sm, loc):
        """Requested rel owning this declaration, FOREIGN, or None if unresolved.

        None means asking slang did not work, and the caller then keeps the
        pre-routing behaviour of crediting the file being parsed. Dropping the
        name instead would shrink the graded population silently while the score
        still read 100% -- the exact false-green this pass exists to prevent.
        """
        if sm is None:
            return None
        try:
            if sm.isMacroLoc(loc):
                # A macro-generated declaration belongs where the macro was
                # USED: that is the file a reader opens to find it.
                loc = sm.getFullyExpandedLoc(loc)
        except Exception:  # noqa: BLE001
            pass
        raw = None
        try:
            raw = str(sm.getFullPath(loc.buffer))
        except Exception:  # noqa: BLE001
            raw = None
        if not raw or raw == ".":
            # getFullPath has no buffer for some synthesized locations; the
            # printable name is cwd-relative but still resolvable.
            try:
                raw = sm.getFileName(loc)
            except Exception:  # noqa: BLE001
                return None
        if not raw:
            return None
        hit = path_cache.get(raw, 0)
        if hit == 0:
            try:
                hit = requested_by_path.get(os.path.normcase(os.path.realpath(raw)), FOREIGN)
            except Exception:  # noqa: BLE001
                hit = None
            path_cache[raw] = hit
        return hit

    # rel -> {"scope": set, "local": set}. Accumulated ACROSS parses: a header's
    # names are discovered while parsing whatever includes it, and again when
    # the header is parsed in its own right.
    buckets = {}
    fragments = set()
    parse_failed = []
    not_on_disk = []
    foreign_dropped = 0

    def bucket_in(store, rel):
        b = store.get(rel)
        if b is None:
            b = {"scope": set(), "local": set()}
            store[rel] = b
        return b

    def fragment_locals(tree, abspath, sm):
        """The declared names of a statement fragment, or None when the file is not one."""
        try:
            members = list(getattr(tree.root, "members", []) or [])
        except Exception:  # noqa: BLE001
            return None
        if any(str(getattr(m, "kind", "")) in CONTAINER_KINDS for m in members):
            return None
        standalone = error_codes(tree)
        if not FRAGMENT_DIAGS.intersection(standalone):
            return None
        try:
            with open(abspath, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            wrapped_text = FRAGMENT_WRAP_HEAD + text + FRAGMENT_WRAP_TAIL
            if sm is not None:
                wrapped = SyntaxTree.fromText(wrapped_text, sm, "fragment", "")
            else:
                wrapped = SyntaxTree.fromText(wrapped_text, "fragment")
        except Exception:  # noqa: BLE001
            return None
        if len(error_codes(wrapped)) >= len(standalone):
            return None
        names = set()

        def collect(node):
            kind = str(getattr(node, "kind", ""))
            if kind not in DECL_KINDS and kind not in HEADER_KINDS:
                return
            name = name_of(node)
            if name and name != "__codegraph_fragment__":
                names.add(name)

        try:
            wrapped.root.visit(collect)
        except Exception:  # noqa: BLE001
            return None
        return names

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

        # Syntax-only mode still processes relative includes, so it still needs
        # a manager to route them; the tree carries the one it used.
        tree_sm = source_manager if source_manager is not None else getattr(tree, "sourceManager", None)

        fragment_names = fragment_locals(tree, abspath, source_manager)
        if fragment_names is not None:
            # Graded loosely: no design-scope name, its declarations reported as
            # the locals they are in the block the file is included into.
            fragments.add(rel)
            bucket_in(buckets, rel)["local"] |= fragment_names
            continue

        # Staged per parse and merged only on success, so a walk that throws
        # partway leaves the report exactly as a failed parse always did.
        pending = {}
        pending_foreign = [0]

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

        def visit(node, _rel=rel, _sm=tree_sm, _p=pending, _pf=pending_foreign):
            kind = str(getattr(node, "kind", ""))
            if kind not in DECL_KINDS and kind not in HEADER_KINDS:
                return
            name = name_of(node)
            if not name:
                return
            try:
                owner = origin_of(_sm, node.sourceRange.start)
            except Exception:  # noqa: BLE001
                owner = None
            if owner is FOREIGN:
                # Declared in a file outside the graded set -- an unscoped or
                # unindexed header. Not this file's name, and not one this run
                # was asked to grade.
                _pf[0] += 1
                return
            target = _rel if owner is None else owner
            key = "local" if is_local(node, skip_own_declaration=(kind == PROTOTYPE_KIND)) else "scope"
            bucket_in(_p, target)[key].add(name)

        try:
            tree.root.visit(visit)
        except Exception:  # noqa: BLE001
            parse_failed.append(rel)
            continue

        for target, b in pending.items():
            dest = bucket_in(buckets, target)
            dest["scope"] |= b["scope"]
            dest["local"] |= b["local"]
        foreign_dropped += pending_foreign[0]
        # A file that parsed cleanly and declares nothing still reports, exactly
        # as it did before routing existed.
        bucket_in(buckets, rel)

    out_files = {}
    for rel, b in buckets.items():
        if rel in fragments:
            # Names other files' parses attributed here are dropped with the
            # rest: a fragment is not graded name by name.
            out_files[rel] = {"scope": [], "local": sorted(b["local"]), "fragment": True}
        else:
            out_files[rel] = {"scope": sorted(b["scope"]), "local": sorted(b["local"])}
    if foreign_dropped:
        notes.append(
            "%d declaration(s) are declared in files outside the graded set (unscoped or "
            "unindexed headers) and were attributed to no graded file" % foreign_dropped
        )

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
