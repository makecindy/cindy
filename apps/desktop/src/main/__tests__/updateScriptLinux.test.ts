import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLinuxUpdateScript,
  escapeEre,
  shellSingleQuote,
  DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS,
  type LinuxUpdateScriptParams,
} from '../updateScriptLinux';

function makeParams(overrides: Partial<LinuxUpdateScriptParams> = {}): LinuxUpdateScriptParams {
  return {
    pid: 12345,
    debPath: '/tmp/cindy-0.0.2-amd64.deb',
    exePath: '/usr/lib/cindy/Cindy',
    lockFilePath: '/tmp/cindy-update.lock',
    scriptPath: '/tmp/cindy-update-1.sh',
    logPath: '/tmp/cindy-update.log',
    ...overrides,
  };
}

describe('shellSingleQuote', () => {
  it('wraps paths in single quotes and escapes embedded quotes', () => {
    expect(shellSingleQuote(`/tmp/cindy's.deb`)).toBe(`'/tmp/cindy'\\''s.deb'`);
    expect(shellSingleQuote('/usr/lib/cindy/Cindy')).toBe(`'/usr/lib/cindy/Cindy'`);
  });
});

describe('buildLinuxUpdateScript structure', () => {
  const script = buildLinuxUpdateScript(makeParams());

  it('installs the staged .deb through pkexec apt-get or dpkg', () => {
    expect(script).toContain('PKEXEC=/usr/bin/pkexec');
    expect(script).toContain('/usr/bin/apt-get install --yes --allow-downgrades');
    expect(script).toContain('/usr/bin/dpkg --install');
    expect(script).toContain(`'/tmp/cindy-0.0.2-amd64.deb'`);
  });

  it('does not overwrite files under /usr without pkexec', () => {
    expect(script).not.toMatch(/rm -rf ['"]?\/usr/);
    expect(script).toContain('"$PKEXEC" /usr/bin/apt-get install --yes --allow-downgrades');
    expect(script).toContain('"$PKEXEC" /usr/bin/dpkg --install');
  });

  it('escalates SIGKILL at exitKillAfterSeconds and aborts at exitAbortAfterSeconds', () => {
    const t = DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS;
    const killIdx = script.indexOf(`-eq ${t.exitKillAfterSeconds} `);
    const abortIdx = script.indexOf(`-ge ${t.exitAbortAfterSeconds} `);
    expect(killIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(killIdx);
    const abortBlock = script.slice(abortIdx, script.indexOf('done', abortIdx));
    expect(abortBlock).toContain('exit 1');
    expect(script.slice(killIdx, abortIdx)).toContain('kill -9 12345');
  });

  it('relaunches the previous binary if install fails', () => {
    expect(script).toContain('INSTALL FAILED — relaunching previous binary');
    expect(script).toContain(`nohup '/usr/lib/cindy/Cindy' >/dev/null 2>&1 &`);
  });

  it('uses an ERE-escaped path for pgrep verification', () => {
    expect(script).toContain(`pgrep -f '${escapeEre('/usr/lib/cindy/Cindy')}'`);
  });

  it.runIf(process.platform !== 'win32')('renders to valid bash (bash -n)', () => {
    const tmp = path.join(os.tmpdir(), `cindy-linux-script-syntax-${process.pid}.sh`);
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    try {
      execFileSync('/bin/bash', ['-n', tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
