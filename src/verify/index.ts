/**
 * `codegraph verify` — grade the index against an independent compiler
 * front-end and report where they disagree.
 *
 * There was no standing proof the index is correct. The 100% design-scope
 * recall figure that motivated this came from a one-off script, and two defects
 * found while establishing it show why that matters: an index serving nodes
 * from files that had been DELETED from disk, and an ambiguous file extension
 * routing a Verilog include to another language's extractor. Both produced WRONG
 * answers, not missing ones, and neither was detectable from inside the tool.
 *
 * Three properties are load-bearing:
 *
 *   1. Scoping is MANDATORY, not optional. Only files the index actually
 *      contains are graded. Grading everything on disk was measured to produce a
 *      meaningless result on a corpus carrying a large vendor library tree the
 *      index was never asked to cover — the tool was being graded on files it
 *      deliberately skipped.
 *   2. The grader GRADES. It never extracts, and it never removes a node.
 *      Extraction stays tree-sitter-based and keeps indexing the union of all
 *      conditional-compilation branches, because a code-intelligence tool must
 *      be able to find code in a branch that is not currently compiled.
 *   3. In the DEFAULT mode every degradation path is a printed SKIP with a
 *      success exit code. A verification pass that can block a teammate is
 *      worse than none.
 *   4. `--strict` inverts property 3 on purpose, because it means something
 *      different: "prove it". A skip, or a run that graded zero declarations,
 *      is NOT a pass in strict mode — it is the absence of evidence, and the
 *      exit code has to be able to say so. Otherwise a CI image that loses
 *      pyslang, or an exclude glob that empties the population, greens the gate
 *      forever with an exit code indistinguishable from "graded and clean".
 */
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import type { QueryBuilder } from '../db/queries';
import { loadVerifyConfig } from '../project-config';
import { runGrader, type GraderReport } from './grader';
import {
  classifyFile,
  conditionalRegions,
  summarize,
  type ClassifyResult,
  type IndexedFile,
} from './classify';

/**
 * The decorator marking a `constant` node as a `` `define `` rather than a
 * parameter (mirrors SV_MACRO_DECORATOR in the SystemVerilog extractor).
 *
 * A preprocessor symbol is NOT a declaration: slang consumes `` `define `` during
 * preprocessing, so a macro name can never appear in the graded population no
 * matter how the oracle is configured. Leaving macros in would make every one of
 * them fire the UNEXPLAINED tripwire — a real design can carry many —
 * which is a population error, not a finding. Excluding them states the
 * population correctly; it does not weaken the tripwire.
 */
const MACRO_DECORATOR = 'macro';

/** Node kinds the grader's declaration population is comparable to. */
const GRADED_NODE_KINDS = [
  'field',
  'constant',
  'module',
  'class',
  'namespace',
  'function',
  'method',
  'type_alias',
  'enum',
  'enum_member',
  'interface',
  'variable',
] as const;

/** Default oracle budget. Generous: a large corpus parses slowly, once. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

export interface VerifyOptions {
  /**
   * Demand evidence. Exits non-zero on any MISSING, and also when the oracle
   * never ran (skip) or graded nothing — in strict mode an ungraded run is a
   * failure, not a pass. For CI.
   */
  strict?: boolean;
  timeoutMs?: number;
}

export type VerifyOutcome =
  | {
      status: 'skipped';
      reason: string;
      /** Stale entries are found without the grader, so they still report. */
      staleFiles: string[];
      scopedFiles: number;
      /**
       * SystemVerilog files in the index BEFORE the config's globs narrow it.
       * The discriminator between the two zeroes: a project holding no
       * SystemVerilog owes no evidence, while a project whose config excluded
       * all of its SystemVerilog owes exactly the evidence it just skipped.
       */
      indexedFiles: number;
      /**
       * Files of ANY language in the index. Zero SystemVerilog is only benign
       * when the index actually holds something else; an index holding nothing
       * at all was never built, or lost its rows, and letting that pass is the
       * worst outcome available — the design is real and unverified.
       */
      indexedFilesTotal: number;
      /** Configured `verify.includeDirs` that are not directories on disk. */
      unusableIncludeDirs: string[];
    }
  | {
      status: 'ok';
      report: GraderReport;
      result: ClassifyResult;
      staleFiles: string[];
      scopedFiles: number;
      indexedFiles: number;
      indexedFilesTotal: number;
      /** Files the oracle actually returned a verdict for. */
      gradedFiles: number;
      /**
       * The project's coverage floor for `--strict`: the share of the
       * SystemVerilog files IN THE INDEX that must come back graded.
       */
      minCoverage: number;
      /** True when the project supplied include dirs / defines / globs. */
      configured: boolean;
      /** Files the grader could not parse at all. */
      parseFailed: string[];
      /**
       * Configured `verify.includeDirs` that are not directories on disk.
       *
       * A run that could not apply the include path it was configured with is
       * strictly weaker than the one asked for, and the weakening is INVISIBLE
       * in the score: unresolved includes mean the front end never sees the
       * declarations, so nothing is MISSING and the run exits 0 looking clean.
       * That is the same false-green shape as grading nothing at all, so it is
       * gated the same way.
       */
      unusableIncludeDirs: string[];
    };

/** Normalize an index path to the forward-slash form the oracle speaks. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * How many files must be graded for `--strict` to pass, from a fractional floor.
 *
 * The product is rounded before the ceiling because it is a float: `100 * 0.07`
 * is `7.000000000000001` in IEEE 754, so a bare `Math.ceil` demands 8 files for
 * a floor whose author wrote 7 — and a bare `<` comparison against the raw
 * product fails a run of exactly 7 for the same reason. Rounding to six places
 * first kills the 1e-15 artifact while leaving a genuine fraction alone
 * (41 * 0.9 = 36.9 still requires 37).
 *
 * The gate and the report both read this one function, so they cannot disagree
 * about the number — a report that prints a floor the exit code does not
 * enforce is its own kind of false green.
 */
export function requiredGradedFiles(scopedFiles: number, minCoverage: number): number {
  return Math.ceil(Number((scopedFiles * minCoverage).toFixed(6)));
}

/**
 * The graded population: SystemVerilog files present in the index, narrowed by
 * the project's optional include/exclude globs.
 *
 * The globs can only NARROW. Widening would reintroduce exactly the failure
 * this scoping exists to prevent.
 */
export function scopeFiles(
  indexedPaths: readonly string[],
  include: readonly string[],
  exclude: readonly string[]
): string[] {
  const isIncluded = include.length > 0 ? picomatch(include as string[], { dot: true }) : null;
  const isExcluded = exclude.length > 0 ? picomatch(exclude as string[], { dot: true }) : null;
  return indexedPaths
    .map(norm)
    .filter((p) => (isIncluded ? isIncluded(p) : true))
    .filter((p) => (isExcluded ? !isExcluded(p) : true))
    .sort();
}

/**
 * Run the verify pass. Never throws — every failure is an outcome.
 */
export function verifyIndex(
  root: string,
  queries: QueryBuilder,
  options: VerifyOptions = {}
): VerifyOutcome {
  const config = loadVerifyConfig(root);

  const indexedPaths: string[] = [];
  let indexedFilesTotal = 0;
  for (const file of queries.getAllFiles()) {
    indexedFilesTotal++;
    if (file.language === 'systemverilog') indexedPaths.push(file.path);
  }
  const scoped = scopeFiles(indexedPaths, config.include, config.exclude);

  // Checked HERE rather than trusted to the oracle's notes: the oracle can only
  // report what it tried, and a note is not a gate. This is a configuration
  // fact the caller can establish directly, name precisely, and act on.
  const unusableIncludeDirs = config.includeDirs.filter((d) => {
    try {
      return !fs.statSync(path.join(root, d.replace(/\//g, path.sep))).isDirectory();
    } catch {
      return true; // absent, unreadable — either way it cannot serve an include
    }
  });

  // Stale-entry detection needs no grader, so it runs first and reports even on
  // a skip. This is the defect class that produced confidently wrong answers:
  // an index that answers about a file which no longer exists.
  const staleFiles = scoped.filter((rel) => {
    try {
      return !fs.existsSync(path.join(root, rel.replace(/\//g, path.sep)));
    } catch {
      return false;
    }
  });

  const outcome = runGrader({
    root,
    files: scoped,
    includeDirs: config.includeDirs,
    defines: config.defines,
    timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
  });

  if (outcome.status === 'skipped') {
    return {
      status: 'skipped',
      reason: outcome.reason,
      staleFiles,
      scopedFiles: scoped.length,
      indexedFiles: indexedPaths.length,
      indexedFilesTotal,
      unusableIncludeDirs,
    };
  }

  // What the index holds, per file: name → declaration line.
  //
  // A name is dropped only when EVERY node carrying it in that file is a macro.
  // A `` `define `` and a same-named signal can coexist, and dropping the name
  // outright would turn the signal into a false MISSING.
  const staged = new Map<string, Map<string, { line: number; macroOnly: boolean }>>();
  for (const kind of GRADED_NODE_KINDS) {
    for (const node of queries.iterateNodesByKind(kind)) {
      if (node.language !== 'systemverilog') continue;
      const rel = norm(node.filePath);
      let entry = staged.get(rel);
      if (!entry) {
        entry = new Map();
        staged.set(rel, entry);
      }
      const isMacro = node.decorators?.includes(MACRO_DECORATOR) === true;
      const existing = entry.get(node.name);
      if (!existing) {
        entry.set(node.name, { line: node.startLine, macroOnly: isMacro });
      } else if (existing.macroOnly && !isMacro) {
        // A real declaration outranks the macro that got here first.
        entry.set(node.name, { line: node.startLine, macroOnly: false });
      }
    }
  }
  const indexedByFile = new Map<string, IndexedFile>();
  for (const [rel, entry] of staged) {
    const kept: IndexedFile = new Map();
    for (const [name, v] of entry) {
      if (!v.macroOnly) kept.set(name, v.line);
    }
    indexedByFile.set(rel, kept);
  }

  const verdicts = [];
  for (const [rel, graded] of Object.entries(outcome.report.files)) {
    let source = '';
    try {
      source = fs.readFileSync(path.join(root, rel.replace(/\//g, path.sep)), 'utf8');
    } catch {
      // Unreadable now but parsed a moment ago — treat as having no conditional
      // regions rather than failing the whole pass.
    }
    verdicts.push(
      classifyFile(rel, graded, indexedByFile.get(rel) ?? new Map(), conditionalRegions(source))
    );
  }

  return {
    status: 'ok',
    report: outcome.report,
    result: summarize(verdicts),
    staleFiles,
    scopedFiles: scoped.length,
    indexedFiles: indexedPaths.length,
    indexedFilesTotal,
    gradedFiles: Object.keys(outcome.report.files).length,
    minCoverage: config.minCoverage,
    configured: config.configured,
    parseFailed: outcome.report.parseFailed,
    unusableIncludeDirs,
  };
}

/**
 * Render an outcome as plain text. Shared by the CLI and the MCP tool so the two
 * can never drift into describing the same index differently.
 */
export function formatVerifyReport(outcome: VerifyOutcome, strict = false): string {
  const lines: string[] = [];

  if (outcome.status === 'skipped') {
    lines.push('codegraph verify: SKIPPED — ' + outcome.reason);
    lines.push(
      `  scoped: ${outcome.scopedFiles} of ${outcome.indexedFiles} SystemVerilog files in the index`
    );
    if (outcome.staleFiles.length > 0) {
      lines.push('');
      lines.push(`  STALE — ${outcome.staleFiles.length} indexed file(s) are no longer on disk:`);
      for (const f of outcome.staleFiles.slice(0, 20)) lines.push(`    ${f}`);
      if (outcome.staleFiles.length > 20) lines.push(`    ... +${outcome.staleFiles.length - 20} more`);
      lines.push('  Re-index to drop them; until then the index can answer about files that no longer exist.');
    }
    lines.push('');
    lines.push('  Install the grader with: pip install "pyslang==11.*"');
    if (outcome.indexedFilesTotal === 0) {
      lines.push('');
      lines.push('  EMPTY INDEX — it holds no files of any language, so it was never built or');
      lines.push('  has lost its rows. Everything on disk is unverified; --strict fails on this.');
    } else if (outcome.indexedFiles === 0) {
      // A missing grader on a project with no SystemVerilog is two absences
      // stacked, and only the second one matters. Announcing a strict FAILURE
      // here while verifyExitCode correctly returns 0 would leave the text and
      // the exit code saying opposite things about the same run — and the text
      // is what a person reads.
      lines.push('');
      lines.push('  NOTHING TO VERIFY — the index holds no SystemVerilog either way, so there');
      lines.push('  was no measurement for the oracle to make. --strict does not block on this.');
    } else if (strict) {
      lines.push('');
      lines.push('  STRICT: failing — the oracle never ran, so NOTHING was verified.');
      lines.push('  A skip is a pass only in the default mode; --strict asks for evidence.');
    }
    return lines.join('\n');
  }

  const { result, report } = outcome;

  lines.push(`codegraph verify — graded by ${report.oracle} ${report.version} (${report.mode})`);
  // Named first: it changes what every number below is worth. A run whose
  // include path did not apply cannot see the declarations behind it, so a
  // clean score here means "found nothing to disagree about", not "agreed".
  const badDirs = outcome.unusableIncludeDirs ?? [];
  if (badDirs.length > 0) {
    lines.push('');
    lines.push(`  INCLUDE DIRS — ${badDirs.length} configured path(s) are not directories on disk:`);
    for (const d of badDirs.slice(0, 20)) lines.push(`    ${d}`);
    if (badDirs.length > 20) lines.push(`    ... +${badDirs.length - 20} more`);
    lines.push('  Declarations behind those includes were never reached, so the figures below');
    lines.push('  are a WEAKER run than the one configured, not a cleaner one.');
    if (strict) lines.push('  STRICT: failing — fix the path or drop it from verify.includeDirs.');
    lines.push('');
  }
  if (!outcome.configured) {
    lines.push('  mode: SYNTAX-ONLY — no `verify` block in codegraph.json, so no include path and no defines.');
    lines.push('        Files that depend on headers are graded loosely; add includeDirs/defines to tighten it.');
  }
  // File coverage, stated before the recall figure so the figure is read
  // against what it actually covered. A recall percentage over one file out of
  // forty-one looks exactly like one over all forty-one.
  lines.push(
    `  scoped: ${outcome.scopedFiles} of ${outcome.indexedFiles} SystemVerilog files in the index` +
      `${outcome.scopedFiles < outcome.indexedFiles ? ' (narrowed by verify.include/exclude)' : ''}` +
      `; ${outcome.gradedFiles} graded`
  );
  if (outcome.indexedFiles > 0 && outcome.gradedFiles < outcome.indexedFiles) {
    const floor = requiredGradedFiles(outcome.indexedFiles, outcome.minCoverage);
    const excluded = outcome.indexedFiles - outcome.scopedFiles;
    const ungraded = outcome.scopedFiles - outcome.gradedFiles;
    lines.push(
      `  COVERAGE  ${outcome.gradedFiles} / ${outcome.indexedFiles} indexed files graded` +
        (excluded > 0 ? ` — ${excluded} excluded by config` : '') +
        (ungraded > 0 ? `${excluded > 0 ? ',' : ' —'} ${ungraded} came back with no verdict` : '') +
        `. --strict requires ${floor} (verify.minCoverage ${outcome.minCoverage}).`
    );
  }
  lines.push('');

  if (outcome.indexedFilesTotal === 0) {
    lines.push('  EMPTY INDEX — it holds no files of any language.');
    lines.push('  This index was never built, or has lost its rows. Every file on disk is');
    lines.push('  unverified, which is the failure this pass exists to catch — --strict fails.');
    return lines.join('\n');
  }

  if (outcome.indexedFiles === 0) {
    lines.push('  NOTHING TO VERIFY — the index holds no SystemVerilog.');
    lines.push('  `codegraph verify` grades SystemVerilog against an independent front-end and');
    lines.push('  has nothing to say about any other language. This is not a pass and not a');
    lines.push('  failure: there was no measurement to make, so --strict does not block on it.');
    return lines.join('\n');
  }

  // A ratio over an empty population is not 100% — it is no measurement. Print
  // the absence rather than a perfect score the run did not earn.
  if (result.graded === 0) {
    lines.push('  DESIGN-SCOPE RECALL   0 / 0   NOT MEASURED — the graded population is EMPTY.');
    lines.push('  The oracle ran but produced no declaration to grade, so this run says');
    lines.push('  nothing about the index. Usual causes: every scoped file was excluded by a');
    lines.push('  `verify.exclude` glob, or the grader could not parse anything it was given.');
  } else {
    const pct = (100 * result.hit) / result.graded;
    lines.push(`  DESIGN-SCOPE RECALL   ${result.hit} / ${result.graded}   ${pct.toFixed(1)}%`);
  }
  lines.push(`    MISSING       ${result.missing}   (grader has it, index does not — a real recall bug)`);
  lines.push(`    BRANCH-UNION  ${result.branchUnion}   (index has it, grader does not, inside a conditional region — expected)`);
  lines.push(`    UNEXPLAINED   ${result.unexplained}   (the tripwire — a non-zero here means the classifier needs work)`);
  lines.push('');
  lines.push('  Procedural-local declarations are excluded on BOTH sides: an identifier declared inside');
  lines.push('  a subroutine or procedural block dies at its block\'s end and is neither probeable,');
  lines.push('  connectable nor driveable. This figure is design-scope recall, not a defect count.');

  for (const note of report.notes ?? []) {
    lines.push('  note: ' + note);
  }

  if (report.versionWarning) {
    lines.push('');
    lines.push('  VERSION  ' + report.versionWarning);
  }

  if (outcome.parseFailed.length > 0) {
    lines.push('');
    lines.push(`  the grader could not parse ${outcome.parseFailed.length} file(s) standalone:`);
    for (const f of outcome.parseFailed.slice(0, 10)) lines.push(`    ${f}`);
    if (outcome.parseFailed.length > 10) lines.push(`    ... +${outcome.parseFailed.length - 10} more`);
  }

  if (outcome.staleFiles.length > 0) {
    lines.push('');
    lines.push(`  STALE — ${outcome.staleFiles.length} indexed file(s) are no longer on disk:`);
    for (const f of outcome.staleFiles.slice(0, 20)) lines.push(`    ${f}`);
    if (outcome.staleFiles.length > 20) lines.push(`    ... +${outcome.staleFiles.length - 20} more`);
    lines.push('  Re-index to drop them; until then the index can answer about files that no longer exist.');
  }

  const missing = outcome.result.files.flatMap((f) => f.disagreements.filter((d) => d.verdict === 'MISSING'));
  if (missing.length > 0) {
    lines.push('');
    lines.push('  MISSING declarations:');
    for (const d of missing.slice(0, 30)) lines.push(`    ${d.file}  ${d.name}`);
    if (missing.length > 30) lines.push(`    ... +${missing.length - 30} more`);
  }

  const unexplained = outcome.result.files.flatMap((f) => f.disagreements.filter((d) => d.verdict === 'UNEXPLAINED'));
  if (unexplained.length > 0) {
    lines.push('');
    lines.push('  UNEXPLAINED names (index has them, no conditional region explains it):');
    for (const d of unexplained.slice(0, 30)) lines.push(`    ${d.file}:${d.line ?? '?'}  ${d.name}`);
    if (unexplained.length > 30) lines.push(`    ... +${unexplained.length - 30} more`);
  }

  if (strict && result.missing > 0) {
    lines.push('');
    lines.push(`  STRICT: failing on ${result.missing} MISSING declaration(s).`);
  }

  if (strict && result.graded === 0) {
    lines.push('');
    lines.push('  STRICT: failing — 0 declarations were graded, so the index is UNVERIFIED.');
  }

  return lines.join('\n');
}

/**
 * Process exit code for an outcome.
 *
 * Default mode never blocks: 0 for everything. `--strict` is the opposite
 * contract — "prove it" — and the exit code has to distinguish evidence from
 * the absence of evidence. It fails on a real MISSING, on a skip (the oracle
 * never ran), on a graded population of zero, on a config that excluded every
 * SystemVerilog file the index holds, and on a run that graded a smaller share
 * of its scope than `verify.minCoverage` allows. Without those a CI image that
 * loses pyslang, or an exclude glob, greens the gate forever while proving
 * nothing.
 *
 * The one thing --strict must NOT do is fail a project that owes no evidence.
 * `verify` grades SystemVerilog and nothing else, so a repo that holds none
 * scopes zero files and grades zero declarations — arithmetically identical to
 * the emptied-population false-green, and the reason a bare `graded === 0` test
 * turned every non-SystemVerilog project into a permanent red. `indexedFiles`
 * is what separates them: no SystemVerilog in the index means there was never a
 * measurement to make, and a gate that fires there is just wrong about a
 * TypeScript repo forever.
 */
export function verifyExitCode(outcome: VerifyOutcome, strict = false): number {
  if (!strict) return 0;
  if (outcome.indexedFiles === 0) {
    // No SystemVerilog. Benign only if the index actually holds something else:
    // an index with no files AT ALL was never built, or lost its rows, and
    // greening that is the worst outcome on offer — the design is real, on
    // disk, and completely unverified, which is the failure this pass exists to
    // catch. A TypeScript repo genuinely owes nothing and passes.
    return outcome.indexedFilesTotal === 0 ? 1 : 0;
  }
  // An include path the run could not apply makes the run weaker than the one
  // configured, and says so nowhere the score can see: the front end never
  // reaches the declarations, so nothing reads MISSING and a degraded run exits
  // 0 looking like a clean pass. Measured: one stale entry in a two-entry
  // includeDirs list took a real project from many MISSING to a green 0.
  if ((outcome.unusableIncludeDirs ?? []).length > 0) return 1;
  if (outcome.status === 'skipped') return 1;
  // A run proves only as much as it covered, and the denominator is the whole
  // indexed design — NOT what survived the config's globs. Measuring coverage
  // against post-glob scope made `verify.exclude` a bypass: narrow 41 files to
  // 1, grade that 1, and a run proving nothing exits 0 with a clean 100.0%,
  // indistinguishable from a full pass. Excluding files is still allowed; it
  // now costs an explicit, readable `minCoverage` in codegraph.json instead of
  // being free and invisible.
  if (outcome.gradedFiles < requiredGradedFiles(outcome.indexedFiles, outcome.minCoverage)) {
    return 1;
  }
  if (outcome.result.graded === 0) return 1;
  return outcome.result.missing > 0 ? 1 : 0;
}

export * from './classify';
export * from './grader';
