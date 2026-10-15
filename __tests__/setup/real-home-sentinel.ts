/**
 * Run-level sentinel (vitest `globalSetup`): fingerprints the agent config
 * files in the real home before the run and fails the run if any of them
 * changed by its end. The per-worker redirect (`isolate-home.ts`) is the
 * prevention; this is the detector for a test that bypasses it (for example
 * by resetting HOME to the real profile path).
 *
 * The real home is read from the OS account (`os.userInfo().homedir`), which
 * ignores HOME / USERPROFILE. Only files that agents rarely rewrite on their
 * own are watched, so an unrelated live session does not trip it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WATCHED = [
  path.join('.claude', 'settings.json'),
  path.join('.codex', 'config.toml'),
  path.join('.gemini', 'settings.json'),
  path.join('.cursor', 'mcp.json'),
];

function fingerprint(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'absent';
  }
}

export default function setup(): () => void {
  const home = os.userInfo().homedir;
  const before = new Map(WATCHED.map((rel) => [rel, fingerprint(path.join(home, rel))]));
  return () => {
    const changed = WATCHED.filter((rel) => fingerprint(path.join(home, rel)) !== before.get(rel));
    if (changed.length > 0) {
      throw new Error(
        `the test run changed files in the real home: ${changed.map((r) => path.join(home, r)).join(', ')} ` +
          '(a test wrote outside its temp home, or another process edited them during the run)',
      );
    }
  };
}
