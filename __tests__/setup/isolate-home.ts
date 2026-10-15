/**
 * Per-worker home isolation (vitest `setupFiles`).
 *
 * Installer, upgrade and CLI code resolve agent configs through
 * `os.homedir()` (HOME on POSIX, USERPROFILE on Windows) and the per-OS
 * config roots. A test that reaches one of those writers without its own
 * redirect would edit the contributor's real `~/.claude/settings.json`,
 * `~/.claude.json`, `~/.codegraph/` and friends — `runUpgrade`'s prompt-hook
 * self-heal did exactly that. So every test file starts with the home folder
 * and the config roots pointed at a temp folder; child processes inherit it
 * through `process.env`. Tests that redirect again (installer-targets) still
 * work: they save and restore the temp values.
 *
 * Fails closed: if the redirect does not take, the setup throws and no test
 * in the file runs. Pinned by `__tests__/test-home-isolation.test.ts`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MARKER = 'CODEGRAPH_TEST_HOME';

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

let home = process.env[MARKER];
if (!home || !fs.existsSync(home)) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-home-'));
  process.env[MARKER] = home;
  // Tests that commit without `-c user.*` need an identity; the real global
  // gitconfig is no longer visible from the temp home.
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    '[user]\n\tname = codegraph-test\n\temail = codegraph-test@example.invalid\n',
  );
}

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
delete process.env.HERMES_HOME;
delete process.env.COPILOT_HOME;
for (const dir of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.XDG_CONFIG_HOME]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (samePath(os.homedir(), os.userInfo().homedir) || !samePath(os.homedir(), home)) {
  throw new Error(
    `test home isolation failed: os.homedir() = ${os.homedir()}, expected ${home}; refusing to run tests against the real home`,
  );
}
