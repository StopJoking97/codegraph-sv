/**
 * The suite must never write into the contributor's real home folder.
 *
 * `runUpgrade` ends with `selfHealPromptHook`, which calls
 * `writePromptHookEntry('global')` — a write to `~/.claude/settings.json`
 * resolved through `os.homedir()`. Before the suite redirected the home
 * folder, every successful `runUpgrade` test wrote the front-load hook into
 * the real settings file of whoever ran the suite (when their real
 * `~/.claude.json` already carried a codegraph MCP entry).
 *
 * `__tests__/setup/isolate-home.ts` points HOME / USERPROFILE (and the
 * per-OS config roots) at a temp folder for every test file. These tests
 * pin that: the worker, its child processes and the upgrade self-heal all
 * see the temp home. Each check fails closed — it asserts the redirect
 * BEFORE anything is written, so a missing setup turns red without
 * touching the real home.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runUpgrade, type UpgradeDeps } from '../src/upgrade';

/** The account's profile folder, read from the OS, not from HOME/USERPROFILE. */
function realHome(): string {
  return path.resolve(os.userInfo().homedir);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Throw unless the current home is a redirected temp folder. */
function assertTempHome(): string {
  const home = os.homedir();
  if (samePath(home, realHome())) {
    throw new Error(`test home is the real home (${home}); refusing to continue`);
  }
  if (!isInside(home, os.tmpdir())) {
    throw new Error(`test home ${home} is not inside the temp folder ${os.tmpdir()}`);
  }
  return home;
}

describe('test home isolation', () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('os.homedir() is a temp folder, not the real home', () => {
    expect(() => assertTempHome()).not.toThrow();
  });

  it('the per-OS config roots sit inside the temp home', () => {
    const home = assertTempHome();
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const) {
      const v = process.env[key];
      expect(v, key).toBeDefined();
      expect(isInside(v!, home), `${key}=${v}`).toBe(true);
    }
    for (const key of ['HERMES_HOME', 'COPILOT_HOME'] as const) {
      expect(process.env[key], key).toBeUndefined();
    }
  });

  it('a spawned child process resolves the same temp home', () => {
    const home = assertTempHome();
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(samePath(r.stdout, home)).toBe(true);
  });

  it('the upgrade self-heal writes the prompt hook under the temp home only', async () => {
    const workerHome = assertTempHome();
    // A fresh home inside the worker's temp home, seeded as an already
    // configured global Claude install so the self-heal fires.
    const home = fs.mkdtempSync(path.join(workerHome, 'upgrade-home-'));
    for (const k of ['HOME', 'USERPROFILE']) saved[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assertTempHome();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } } }),
    );

    const deps: UpgradeDeps = {
      currentVersion: '0.9.8',
      method: { kind: 'npm', scope: 'global' },
      resolveLatest: async () => 'v0.9.9',
      run: () => 0,
      capture: () => null,
      hasCommand: () => false,
      log: () => {},
      warn: () => {},
      error: () => {},
      platform: process.platform,
    };
    expect(await runUpgrade({}, deps)).toBe(0);

    const settings = path.join(home, '.claude', 'settings.json');
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.readFileSync(settings, 'utf-8')).toContain('prompt-hook');
  });
});
