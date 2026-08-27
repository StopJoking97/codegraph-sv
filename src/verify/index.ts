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
 *   3. Every degradation path is a printed SKIP with a success exit code. A
 *      verification pass that can block a teammate is worse than none.
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
  /** Exit non-zero on any MISSING. For CI. */
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
    }
  | {
      status: 'ok';
      report: GraderReport;
      result: ClassifyResult;
      staleFiles: string[];
      scopedFiles: number;
      /** True when the project supplied include dirs / defines / globs. */
      configured: boolean;
      /** Files the grader could not parse at all. */
      parseFailed: string[];
    };

/** Normalize an index path to the forward-slash form the oracle speaks. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
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
  for (const file of queries.getAllFiles()) {
    if (file.language === 'systemverilog') indexedPaths.push(file.path);
  }
  const scoped = scopeFiles(indexedPaths, config.include, config.exclude);

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
    return { status: 'skipped', reason: outcome.reason, staleFiles, scopedFiles: scoped.length };
  }

  // What the index holds, per file: name → declaration line.
  const indexedByFile = new Map<string, IndexedFile>();
  for (const kind of GRADED_NODE_KINDS) {
    for (const node of queries.iterateNodesByKind(kind)) {
      if (node.language !== 'systemverilog') continue;
      const rel = norm(node.filePath);
      let entry = indexedByFile.get(rel);
      if (!entry) {
        entry = new Map();
        indexedByFile.set(rel, entry);
      }
      if (!entry.has(node.name)) entry.set(node.name, node.startLine);
    }
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
    configured: config.configured,
    parseFailed: outcome.report.parseFailed,
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
    lines.push(`  scoped: ${outcome.scopedFiles} SystemVerilog files in the index`);
    if (outcome.staleFiles.length > 0) {
      lines.push('');
      lines.push(`  STALE — ${outcome.staleFiles.length} indexed file(s) are no longer on disk:`);
      for (const f of outcome.staleFiles.slice(0, 20)) lines.push(`    ${f}`);
      if (outcome.staleFiles.length > 20) lines.push(`    ... +${outcome.staleFiles.length - 20} more`);
      lines.push('  Re-index to drop them; until then the index can answer about files that no longer exist.');
    }
    lines.push('');
    lines.push('  Install the grader with: pip install "pyslang==11.*"');
    return lines.join('\n');
  }

  const { result, report } = outcome;
  const pct = result.graded > 0 ? (100 * result.hit) / result.graded : 100;

  lines.push(`codegraph verify — graded by ${report.oracle} ${report.version} (${report.mode})`);
  if (!outcome.configured) {
    lines.push('  mode: SYNTAX-ONLY — no `verify` block in codegraph.json, so no include path and no defines.');
    lines.push('        Files that depend on headers are graded loosely; add includeDirs/defines to tighten it.');
  }
  lines.push(`  scoped: ${outcome.scopedFiles} SystemVerilog files in the index; ${Object.keys(report.files).length} graded`);
  lines.push('');
  lines.push(`  DESIGN-SCOPE RECALL   ${result.hit} / ${result.graded}   ${pct.toFixed(1)}%`);
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

  return lines.join('\n');
}

/** Process exit code for an outcome. A skip is always 0. */
export function verifyExitCode(outcome: VerifyOutcome, strict = false): number {
  if (outcome.status === 'skipped') return 0;
  return strict && outcome.result.missing > 0 ? 1 : 0;
}

export * from './classify';
export * from './grader';
