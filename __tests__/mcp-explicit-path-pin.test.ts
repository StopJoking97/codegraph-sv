/**
 * `--path` is an instruction, not a hint.
 *
 * Before this, a client-supplied `rootUri` outranked the `--path` the server
 * was launched with, so an operator could pin the server at one index and be
 * answered from another — silently. On a project where sibling indexes hold
 * different edge kinds (an RTL index vs a workspace index above
 * it) that difference decides whether a net-tracing question is answerable at
 * all, so the override has to be both losable-by-the-client and loud.
 */

import { describe, it, expect } from 'vitest';
import { resolveExplicitProjectPath } from '../src/mcp/session';

const uri = (p: string) => `file://${p}`;

/**
 * `file://` URIs come back platform-normalized (a drive-letter path on
 * Windows), while `--path` is passed through verbatim. Normalize the fixtures
 * through the function itself so both sides are the same shape on every OS —
 * the assertions are about PRECEDENCE, not about path spelling.
 */
const norm = (p: string) =>
  resolveExplicitProjectPath({ rootUri: uri(p), launchPath: null, daemonInternal: false }).path!;
const RTL = norm('/w/proj/rtl');
const WORKSPACE = norm('/w/proj');

describe('resolveExplicitProjectPath', () => {
  it('serves the operator --path even when the client asks for another root', () => {
    const d = resolveExplicitProjectPath({
      rootUri: uri('/w/proj'), launchPath: RTL, daemonInternal: false,
    });
    expect(d.path).toBe(RTL);
    expect(d.overrodeClientRoot).toBe(WORKSPACE); // reported, so it can be logged
  });

  it('does not report an override when both sides agree', () => {
    const d = resolveExplicitProjectPath({
      rootUri: uri('/w/proj/rtl'), launchPath: RTL, daemonInternal: false,
    });
    expect(d.path).toBe(RTL);
    expect(d.overrodeClientRoot).toBeNull();
  });

  it('outranks workspaceFolders too, not just rootUri', () => {
    const d = resolveExplicitProjectPath({
      workspaceFolderUri: uri('/w/proj'), launchPath: RTL, daemonInternal: false,
    });
    expect(d.path).toBe(RTL);
    expect(d.overrodeClientRoot).toBe(WORKSPACE);
  });

  it('keeps client-first precedence for the DAEMON', () => {
    // The daemon's own --path is machinery, not operator intent: one daemon
    // serves clients rooted elsewhere, and pinning it would break that.
    const d = resolveExplicitProjectPath({
      rootUri: uri('/w/proj'), launchPath: RTL, daemonInternal: true,
    });
    expect(d.path).toBe(WORKSPACE);
    expect(d.overrodeClientRoot).toBeNull();
  });

  it('still honors --path when the client sends no root at all', () => {
    expect(resolveExplicitProjectPath({ launchPath: RTL, daemonInternal: true }).path).toBe(RTL);
    expect(resolveExplicitProjectPath({ launchPath: RTL, daemonInternal: false }).path).toBe(RTL);
  });

  it('prefers rootUri over workspaceFolders when there is no --path (issue #196)', () => {
    const d = resolveExplicitProjectPath({
      rootUri: uri('/w/proj/rtl'), workspaceFolderUri: uri('/w/proj'),
      launchPath: null, daemonInternal: false,
    });
    expect(d.path).toBe(RTL);
  });

  it('returns null when nothing explicit is known, so cwd resolution can run', () => {
    expect(resolveExplicitProjectPath({ launchPath: null, daemonInternal: false }).path).toBeNull();
  });
});
