/**
 * The three-way classifier behind `codegraph verify`.
 *
 * Every disagreement between the index and an independent compiler front-end
 * falls into exactly one of three classes, and keeping them apart is the whole
 * point of the pass — a flat "N names differ" number is noise:
 *
 *   MISSING       the grader has a declaration the index does not. A real
 *                 recall bug.
 *   BRANCH-UNION  the index has a name the grader does not, and it sits inside
 *                 a conditional-compilation region. Expected and CORRECT: the
 *                 index deliberately covers the union of all `` `ifdef `` branches
 *                 so an agent can find code in a branch that is not currently
 *                 compiled, while the grader sees one branch.
 *   UNEXPLAINED   anything else. The tripwire. Both MISSING and UNEXPLAINED are
 *                 expected to read zero; a non-zero UNEXPLAINED means the
 *                 CLASSIFIER needs work, not the index.
 *
 * Procedural-local declarations are excluded from the comparison entirely, on
 * both sides. An identifier declared inside a subroutine or procedural block
 * dies at its block's end and is neither probeable, connectable nor driveable;
 * the index does not carry them by design, so counting them as MISSING would
 * report a deliberate scope boundary as a defect.
 */

/** One file's declarations as the grader saw them. */
export interface GradedFile {
  /** Names at module/class/package level — the population being graded. */
  scope: string[];
  /** Names inside a subroutine or procedural block — excluded by design. */
  local: string[];
  /**
   * The file is a statement list meant to be `include-d inside a procedural
   * block, not a compilation unit. The two parsers recover from it differently,
   * so it is graded loosely: no MISSING and no UNEXPLAINED, and the report
   * lists it so the loosening is visible.
   */
  fragment?: boolean;
}

/** A half-open line range `[start, end]`, 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

export type DisagreementClass = 'MISSING' | 'BRANCH-UNION' | 'UNEXPLAINED';

export interface Disagreement {
  file: string;
  name: string;
  verdict: DisagreementClass;
  /** The index's line for the name, when the index is the side that has it. */
  line?: number;
}

/** What the index holds for one file: name → the line it was declared on. */
export type IndexedFile = Map<string, number>;

export interface FileVerdict {
  file: string;
  /** Graded population size — design-scope names the grader found. */
  graded: number;
  /** How many of those the index also has. */
  hit: number;
  disagreements: Disagreement[];
}

export interface ClassifyResult {
  files: FileVerdict[];
  missing: number;
  branchUnion: number;
  unexplained: number;
  graded: number;
  hit: number;
}

/**
 * Line ranges covered by a conditional-compilation directive, 1-based inclusive.
 *
 * Scanning text rather than an AST is deliberate: the grammar has no
 * preprocessor (which is exactly why CodeGraph blanks these directives before
 * parsing), so there is no tree to ask. The scan is a line-oriented reader of
 * `` `ifdef ``/`` `ifndef ``/`` `elsif ``/`` `else ``/`` `endif ``, which is
 * all the classifier needs: it only has to answer "was this name inside SOME
 * conditional region".
 *
 * Everything between the opening directive and its matching `` `endif `` counts,
 * including the directive lines themselves — a declaration on the same line as
 * a directive is still conditional. Unbalanced directives (a `` `ifdef `` with
 * no `` `endif ``) run to end of file rather than being dropped, because the
 * conservative reading is the one that avoids reporting a real branch-union
 * name as UNEXPLAINED.
 */
export function conditionalRegions(source: string): LineRange[] {
  const lines = source.split(/\r?\n/);
  const regions: LineRange[] = [];
  const open: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.indexOf('`') === -1) continue;
    // Only a directive at the start of the line (after whitespace) opens or
    // closes a region — the same shape the extractor's pre-parse blanks.
    if (/^[ \t]*`(?:ifdef|ifndef)\b/.test(line)) {
      open.push(i + 1);
    } else if (/^[ \t]*`endif\b/.test(line)) {
      const start = open.pop();
      if (start !== undefined) regions.push({ start, end: i + 1 });
    }
  }

  // Unbalanced opens run to end of file: better to over-report a region than to
  // classify a genuine branch-union name as the UNEXPLAINED tripwire.
  for (const start of open) regions.push({ start, end: lines.length });

  return regions.sort((a, b) => a.start - b.start);
}

/** True when `line` falls inside any of the ranges. */
export function inConditionalRegion(line: number | undefined, regions: readonly LineRange[]): boolean {
  if (line === undefined) return false;
  return regions.some((r) => line >= r.start && line <= r.end);
}

/**
 * Classify one file's disagreements.
 *
 * `graded.local` is subtracted from the index side as well as excluded from the
 * grader side: a name the index happens to hold that the grader classed as
 * procedural-local is not evidence of anything, and calling it UNEXPLAINED
 * would fire the tripwire on a scope boundary both sides agree about.
 */
export function classifyFile(
  file: string,
  graded: GradedFile,
  indexed: IndexedFile,
  regions: readonly LineRange[]
): FileVerdict {
  if (graded.fragment === true) return { file, graded: 0, hit: 0, disagreements: [] };
  const scope = new Set(graded.scope);
  const local = new Set(graded.local);
  const disagreements: Disagreement[] = [];

  let hit = 0;
  for (const name of scope) {
    if (indexed.has(name)) hit++;
    else disagreements.push({ file, name, verdict: 'MISSING' });
  }

  for (const [name, line] of indexed) {
    if (scope.has(name) || local.has(name)) continue;
    disagreements.push({
      file,
      name,
      line,
      verdict: inConditionalRegion(line, regions) ? 'BRANCH-UNION' : 'UNEXPLAINED',
    });
  }

  return { file, graded: scope.size, hit, disagreements };
}

/** Roll per-file verdicts into the report's totals. */
export function summarize(files: readonly FileVerdict[]): ClassifyResult {
  let missing = 0;
  let branchUnion = 0;
  let unexplained = 0;
  let graded = 0;
  let hit = 0;
  for (const f of files) {
    graded += f.graded;
    hit += f.hit;
    for (const d of f.disagreements) {
      if (d.verdict === 'MISSING') missing++;
      else if (d.verdict === 'BRANCH-UNION') branchUnion++;
      else unexplained++;
    }
  }
  return { files: [...files], missing, branchUnion, unexplained, graded, hit };
}
