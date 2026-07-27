import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_SH } from '../bootstrap/bootstrap-script.js';
import {
  installRemoteAgent,
  PINNED_CLAUDE_CODE_VERSION,
  PINNED_CODEX_RELEASE_VERSION,
  probeRemoteAgent,
} from '../bootstrap/installer.js';
import type { RemoteHost } from '../RemoteHost.js';

describe('remote agent installer', () => {
  it('passes the pinned Codex release to the remote bootstrap script', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'PROBE_START',
            'INSTALL_DIR /home/u/.xdt-server/v1',
            `READY ${PINNED_CODEX_RELEASE_VERSION}`,
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const result = await installRemoteAgent(host, 'codex');

    expect(result.ready).toBe(true);
    expect(result.installedVersion).toBe(PINNED_CODEX_RELEASE_VERSION);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain(`'${PINNED_CODEX_RELEASE_VERSION}'`);
    expect(calls[0].input).toBe(BOOTSTRAP_SH);
  });

  it('runs install.sh with --release when a Codex release arg is present', () => {
    expect(BOOTSTRAP_SH).toContain('INSTALLER_URL="https://github.com/openai/codex/releases/download/rust-v$CODEX_RELEASE/install.sh"');
    expect(BOOTSTRAP_SH).toContain('sh "$INSTALLER_TMP" --release "$CODEX_RELEASE"');
  });

  it('pins Claude Code for probe and install, and rejects a stale sentinel version', async () => {
    const calls: Array<{ command: string; input: string }> = [];
    const host = {
      exec: async (command: string, opts: { input?: string }) => {
        calls.push({ command, input: opts.input ?? '' });
        return {
          exitCode: 0,
          stdout: [
            'INSTALL_DIR /home/u/.xdt-server/v1',
            'NOT_INSTALLED',
          ].join('\n'),
          stderr: '',
        };
      },
    } as Pick<RemoteHost, 'exec'> as RemoteHost;

    const probe = await probeRemoteAgent(host, 'claude-code');
    expect(probe.installed).toBe(false);
    expect(calls[0].command).toContain(`'${PINNED_CLAUDE_CODE_VERSION}'`);
    expect(calls[0].input).toContain(
      '[ "${V%% *}" = "$CLAUDE_RELEASE" ]',
    );

    await installRemoteAgent(host, 'claude-code');
    expect(calls[1].command).toContain(`'${PINNED_CLAUDE_CODE_VERSION}'`);
    expect(calls[1].input).toContain(
      'NPM_PKG="@anthropic-ai/claude-code@$CLAUDE_RELEASE"',
    );
    expect(calls[1].input).toContain(
      'Claude Code version ${V%% *} != managed pin $CLAUDE_RELEASE',
    );
  });
});
