/**
 * The grader child process behind `codegraph verify`.
 *
 * The oracle is an independent compiler front-end (slang, via its Python
 * binding), invoked as a CHILD PROCESS and spoken to over JSON on stdin/stdout.
 * A child process rather than a dependency because it must be possible not to
 * have it: absence, failure and timeout all degrade to a printed skip with a
 * SUCCESS exit code. A verification pass that can block a teammate is worse than
 * no verification pass.
 *
 * The version is PINNED. A silently shrinking graded population would let the
 * report print a perfect score while missing entire declaration classes —
 * strictly worse than not running at all — so a version outside the supported
 * range is reported rather than tolerated.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { GradedFile } from './classify';

/** Oracle protocol version this build speaks. Bumped with the wire shape. */
export const ORACLE_PROTOCOL = 1;

/**
 * pyslang versions this build's declaration-kind table was validated against.
 * The kind names the oracle keys on (`SyntaxKind.Declarator`, `ModuleHeader`,
 * …) are slang's, not ours; a major bump can rename or re-nest them, and the
 * failure mode is a SMALLER graded population that still scores 100%.
 */
export const SUPPORTED_ORACLE_MAJORS: readonly number[] = [11];

export interface GraderJob {
  root: string;
  /** Project-root-relative, already scoped to what the index contains. */
  files: string[];
  includeDirs: string[];
  defines: Record<string, string>;
  timeoutMs: number;
}

export interface GraderReport {
  oracle: string;
  version: string;
  /** `preprocessed` when an include path was applied, else `syntax-only`. */
  mode: 'preprocessed' | 'syntax-only';
  /**
   * What the oracle could NOT apply, verbatim. pyslang 11 exposes include
   * directories but no way to predefine macros from Python, so a configured
   * `defines` block lands here rather than being silently ignored — a verify
   * pass that overstates its own rigour is worse than one that admits it graded
   * loosely.
   */
  notes: string[];
  files: Record<string, GradedFile>;
  parseFailed: string[];
  notOnDisk: string[];
  /** Set when the version is outside SUPPORTED_ORACLE_MAJORS. */
  versionWarning?: string;
}

export type GraderOutcome =
  | { status: 'ok'; report: GraderReport }
  | { status: 'skipped'; reason: string };

/** Where the bundled oracle script lives, for a built dist AND a source run. */
export function oracleScriptPath(): string | null {
  const candidates = [
    // dist/verify/grader.js -> <pkg>/scripts/sv/slang-oracle.py
    path.join(__dirname, '..', '..', 'scripts', 'sv', 'slang-oracle.py'),
    // src/verify/grader.ts (vitest, tsx) -> <repo>/scripts/sv/slang-oracle.py
    path.join(__dirname, '..', '..', '..', 'scripts', 'sv', 'slang-oracle.py'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c);
    } catch {
      // An unreadable candidate is just not the one.
    }
  }
  return null;
}

/** Python interpreters to try, in order. Overridable for a venv or a pinned build. */
function pythonCandidates(): string[] {
  const override = process.env.CODEGRAPH_VERIFY_PYTHON;
  if (override) return [override];
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

/**
 * Run the oracle over `job`. NEVER throws: every failure path returns a
 * `skipped` outcome carrying the reason, which the caller prints before exiting
 * successfully.
 */
export function runGrader(job: GraderJob): GraderOutcome {
  const script = oracleScriptPath();
  if (!script) return { status: 'skipped', reason: 'the bundled oracle script is missing from this install' };

  const payload = JSON.stringify({
    protocol: ORACLE_PROTOCOL,
    root: job.root,
    files: job.files,
    includeDirs: job.includeDirs,
    defines: job.defines,
  });

  let lastReason = 'no Python interpreter found on PATH';
  for (const python of pythonCandidates()) {
    let result;
    try {
      result = spawnSync(python, [script], {
        input: payload,
        encoding: 'utf8',
        timeout: job.timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (err) {
      lastReason = `could not start ${python}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      // ENOENT just means this candidate interpreter is not this machine's.
      if (code === 'ENOENT') {
        lastReason = 'no Python interpreter found on PATH';
        continue;
      }
      if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
        return { status: 'skipped', reason: `the oracle timed out after ${job.timeoutMs}ms` };
      }
      return { status: 'skipped', reason: `the oracle could not be started: ${result.error.message}` };
    }
    if (result.signal) {
      return { status: 'skipped', reason: `the oracle was killed (${result.signal}) — likely the ${job.timeoutMs}ms timeout` };
    }
    if (result.status === 2) {
      return { status: 'skipped', reason: 'pyslang is not installed (pip install "pyslang==11.*")' };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim().split('\n').slice(-3).join(' ');
      return { status: 'skipped', reason: `the oracle exited with ${result.status}${stderr ? `: ${stderr}` : ''}` };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return { status: 'skipped', reason: 'the oracle produced output this build could not parse' };
    }
    if (parsed.protocol !== ORACLE_PROTOCOL) {
      return {
        status: 'skipped',
        reason: `the oracle speaks protocol ${String(parsed.protocol)}, this build speaks ${ORACLE_PROTOCOL}`,
      };
    }

    const version = String(parsed.version ?? 'unknown');
    const major = Number(version.split('.')[0]);
    const versionWarning = SUPPORTED_ORACLE_MAJORS.includes(major)
      ? undefined
      : `pyslang ${version} is outside the validated range (${SUPPORTED_ORACLE_MAJORS.map((m) => `${m}.x`).join(', ')}); ` +
        'the graded population may be smaller than it looks, so treat a perfect score as unproven';

    return {
      status: 'ok',
      report: {
        oracle: String(parsed.oracle ?? 'unknown'),
        version,
        mode: parsed.mode === 'preprocessed' ? 'preprocessed' : 'syntax-only',
        notes: (parsed.notes ?? []) as string[],
        files: (parsed.files ?? {}) as Record<string, GradedFile>,
        parseFailed: (parsed.parseFailed ?? []) as string[],
        notOnDisk: (parsed.notOnDisk ?? []) as string[],
        versionWarning,
      },
    };
  }

  return { status: 'skipped', reason: lastReason };
}
