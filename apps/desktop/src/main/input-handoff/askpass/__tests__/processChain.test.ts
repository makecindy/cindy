import { describe, expect, it } from 'vitest';
import { verifyAskpassChain, verifyAskpassRecoveryChain, type ProcessFacts, type ProcessProbe } from '../processChain.js';

const USER = 501;
const SOCK = '/tmp/cindy-ih-x/s';
const curl = (ppid: number): ProcessFacts => ({
  pid: 100, ppid, uid: USER, args: `/usr/bin/curl -sS --unix-socket ${SOCK} http://cindy/askpass`,
});

function probe(processes: Array<ProcessFacts & { exe?: string }>): ProcessProbe {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return {
    facts: async (pid) => {
      const p = byPid.get(pid);
      return p ? { pid: p.pid, ppid: p.ppid, uid: p.uid, args: p.args } : null;
    },
    executable: async (pid) => byPid.get(pid)?.exe ?? null,
  };
}

const verify = (processes: Array<ProcessFacts & { exe?: string }>) =>
  verifyAskpassChain(probe(processes), 100, SOCK, USER);

describe('askpass asker check', () => {
  it('accepts the real setuid sudo and shows its command', async () => {
    const verdict = await verify([
      { ...curl(200), exe: '/usr/bin/curl' },
      { pid: 200, ppid: 1, uid: 0, args: 'sudo -A launchctl kickstart system/com.example' },
    ]);
    expect(verdict).toEqual({ ok: true, asker: { program: 'sudo', command: 'sudo -A launchctl kickstart system/com.example' } });
  });

  it('refuses a "sudo" that is not running as root', async () => {
    const verdict = await verify([
      { ...curl(200), exe: '/usr/bin/curl' },
      { pid: 200, ppid: 1, uid: USER, args: 'sudo -A true', exe: '/Users/someone/bin/sudo' },
    ]);
    expect(verdict).toEqual({ ok: false, reason: 'sudo' });
  });

  it('accepts system ssh and refuses ssh built somewhere the agent can write', async () => {
    const ssh = { pid: 200, ppid: 1, uid: USER, args: 'ssh deploy@build.example' };
    expect(await verify([{ ...curl(200), exe: '/usr/bin/curl' }, { ...ssh, exe: '/usr/bin/ssh' }]))
      .toMatchObject({ ok: true, asker: { program: 'ssh' } });
    expect(await verify([{ ...curl(200), exe: '/usr/bin/curl' }, { ...ssh, exe: '/Users/someone/work/ssh' }]))
      .toEqual({ ok: false, reason: 'parent' });
    expect(await verify([{ ...curl(200), exe: '/usr/bin/curl' }, { ...ssh, exe: '/usr/bin/../../tmp/ssh' }]))
      .toEqual({ ok: false, reason: 'parent' });
  });

  it('refuses `git credential fill`, which would print the password', async () => {
    const verdict = await verify([
      { ...curl(200), exe: '/usr/bin/curl' },
      { pid: 200, ppid: 1, uid: USER, args: 'git credential fill', exe: '/Library/Developer/CommandLineTools/usr/bin/git' },
    ]);
    expect(verdict).toEqual({ ok: false, reason: 'parent' });
  });

  it('names the git command the agent ran for an HTTPS prompt', async () => {
    const core = '/Library/Developer/CommandLineTools/usr/libexec/git-core';
    const verdict = await verify([
      { ...curl(300), exe: '/usr/bin/curl' },
      { pid: 300, ppid: 250, uid: USER, args: `${core}/git-remote-https origin https://git.example/r.git`, exe: `${core}/git-remote-http` },
      { pid: 250, ppid: 200, uid: USER, args: `${core}/git remote-https origin https://git.example/r.git` },
      { pid: 200, ppid: 1, uid: USER, args: 'git push origin main' },
    ]);
    expect(verdict).toEqual({ ok: true, asker: { program: 'git', command: 'git push origin main', gitOrigin: 'https://git.example' } });
  });

  it('refuses when the asking process is not the helper', async () => {
    expect(await verify([
      { pid: 100, ppid: 200, uid: USER, args: 'python3 fake.py', exe: '/usr/bin/python3' },
      { pid: 200, ppid: 1, uid: 0, args: 'sudo -A true' },
    ])).toEqual({ ok: false, reason: 'helper' });
    expect(await verify([
      { ...curl(200), exe: '/Users/someone/bin/curl' },
      { pid: 200, ppid: 1, uid: 0, args: 'sudo -A true' },
    ])).toEqual({ ok: false, reason: 'helper' });
  });
});

describe('metadata-only askpass recovery preflight', () => {
  const helperPath = '/tmp/cindy-ih-x/askpass';
  const shell = { pid: 100, ppid: 200, uid: USER, args: `/bin/sh ${helperPath} Username for GitHub`, exe: '/bin/bash' };
  const git = { pid: 200, ppid: 1, uid: USER, args: 'git-remote-https origin https://github.com/owner/repo.git',
    exe: '/usr/lib/git-core/git-remote-https' };

  it('verifies the shell for guidance but never for credential delivery', async () => {
    const p = probe([shell, git]);
    expect(await verifyAskpassRecoveryChain(p, 100, helperPath, USER))
      .toMatchObject({ ok: true, asker: { program: 'git', gitOrigin: 'https://github.com' } });
    expect(await verifyAskpassChain(p, 100, SOCK, USER)).toEqual({ ok: false, reason: 'helper' });
  });

  it.each([
    { ...shell, args: `/bin/sh -c ${helperPath}` },
    { ...shell, args: `/bin/sh ${helperPath}-other` },
    { ...shell, exe: '/tmp/sh' },
    { ...shell, uid: USER + 1 },
  ])('rejects a different helper invocation', async (invalid) => {
    expect(await verifyAskpassRecoveryChain(probe([invalid, git]), 100, helperPath, USER))
      .toEqual({ ok: false, reason: 'helper' });
  });

  it('offers guidance to bundled Git without allowing it to receive a credential', async () => {
    const bundled = { ...git, exe: '/opt/agent-runtime/git-core/git-remote-https' };
    expect(await verifyAskpassRecoveryChain(probe([shell, bundled]), 100, helperPath, USER))
      .toMatchObject({ ok: true, asker: { program: 'git', gitOrigin: 'https://github.com' } });
    expect(await verifyAskpassChain(probe([{ ...curl(200), exe: '/usr/bin/curl' }, bundled]), 100, SOCK, USER))
      .toEqual({ ok: false, reason: 'parent' });
  });

  it('rejects a direct agent invocation and credential dump', async () => {
    for (const parent of [
      { ...git, args: 'node agent.js', exe: '/usr/local/bin/node' },
      { ...git, args: 'git credential fill', exe: '/usr/bin/git' },
    ]) {
      expect(await verifyAskpassRecoveryChain(probe([shell, parent]), 100, helperPath, USER))
        .toEqual({ ok: false, reason: 'parent' });
    }
  });
});
