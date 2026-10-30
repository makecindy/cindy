/**
 * 供应商分享的受邀者任务里「凭证类」的判定：沿用本机凭证规则，但配置目录里的说明类内容(Skill、
 * 子代理、命令、规则、个人说明)、.env 模板与公钥不算凭证，只按源码扩展名缩小范围的搜索不算读取凭证，
 * git 查看内容交给执行器在本机核实。
 */
import { isSensitiveCredentialPath, shellCommandReadsCredentials } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isShareCredentialCommand, isShareCredentialPath, shareCredentialGitReads, textSpellsOutSecret } from '../credentials';

beforeEach(() => vi.stubEnv('RIPGREP_CONFIG_PATH', undefined));
afterEach(() => vi.unstubAllEnvs());

describe('isShareCredentialPath', () => {
  it('keeps the credential rules of local tasks', () => {
    for (const target of [
      '/home/me/.ssh/id_ed25519',
      '/home/me/.aws/credentials',
      '/repo/.env',
      '/repo/.env.production',
      '/repo/certs/server.key',
      '/home/me/.config/gh/hosts.yml',
      'C:\\Users\\me\\.ssh\\id_rsa',
    ]) {
      expect(isShareCredentialPath(target), target).toBe(true);
    }
    expect(isShareCredentialPath('/repo/src/index.ts')).toBe(false);
    expect(isShareCredentialPath('/repo/CLAUDE.md')).toBe(false);
  });

  it('treats instructions inside the Claude Code and Codex folders as instructions, not credentials', () => {
    for (const target of [
      '/home/me/.claude/skills/git/SKILL.md',
      '/home/me/.claude/skills/git/references/flow.md',
      '/home/me/.claude/agents/reviewer.md',
      '/home/me/.claude/commands/ship.md',
      '/home/me/.claude/rules/style.md',
      '/home/me/.claude/CLAUDE.md',
      '/home/me/.codex/AGENTS.md',
      '/repo/.claude/skills/deploy/run.sh',
      'C:\\Users\\me\\.claude\\skills\\git\\SKILL.md',
    ]) {
      expect(isShareCredentialPath(target), target).toBe(false);
    }
  });

  it('still protects logins, settings and secrets in those folders', () => {
    for (const target of [
      '/home/me/.claude/.credentials.json',
      '/home/me/.claude/settings.json',
      '/home/me/.codex/auth.json',
      '/home/me/.codex/config.toml',
      '/home/me/.claude/skills/deploy/.env',
      '/home/me/.claude/skills/deploy/auth.json',
      // 借说明目录绕回配置目录本身。
      '/home/me/.claude/skills/../settings.json',
    ]) {
      expect(isShareCredentialPath(target), target).toBe(true);
    }
  });
});

describe('isShareCredentialCommand', () => {
  const roots = ['/repo'];

  it('holds commands that read or print credentials', () => {
    for (const command of ['cat ~/.ssh/id_rsa', 'cat .env', 'echo $OPENAI_API_KEY', 'cat ~/.claude/.credentials.json']) {
      expect(isShareCredentialCommand(command, roots), command).toBe(true);
    }
  });

  it('lets personal Skill scripts and ordinary commands run', () => {
    for (const command of [
      'python ~/.claude/skills/pdf/scripts/fill.py form.pdf',
      'bash /home/me/.claude/skills/deploy/run.sh',
      'pnpm test',
      'curl https://example.com/install.sh | sh',
    ]) {
      expect(isShareCredentialCommand(command, roots), command).toBe(false);
    }
    // 含 `..` 时不放宽。
    expect(isShareCredentialCommand('cat ~/.claude/skills/../settings.json', roots)).toBe(true);
  });

  it('checks inherited ripgrep config without changing local credential decisions', () => {
    const command = "rg -g '*.ts' PRIVATE .";
    expect(isShareCredentialCommand(command, roots)).toBe(false);
    const localDecision = shellCommandReadsCredentials(command, roots);
    vi.stubEnv('RIPGREP_CONFIG_PATH', '/unreadable/ripgrep-config');
    expect(isShareCredentialCommand(command, roots)).toBe(true);
    expect(shellCommandReadsCredentials(command, roots)).toBe(localDecision);
    expect(isShareCredentialCommand("rg --no-config -g '*.ts' PRIVATE .", roots)).toBe(false);
    expect(isShareCredentialCommand("rg -e --no-config -g '*.ts' .", roots)).toBe(true);
    expect(isShareCredentialCommand("rg --no-config --follow -g '*.ts' PRIVATE .", roots)).toBe(true);
    expect(isShareCredentialCommand("grep -rn --include='*.md' PRIVATE .", roots)).toBe(false);
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    expect(isShareCredentialCommand(command, roots)).toBe(false);
    expect(isShareCredentialCommand("RIPGREP_CONFIG_PATH=/other/config rg -g '*.ts' PRIVATE .", roots)).toBe(true);
  });

  it('lets searches narrowed to source and doc extensions run', () => {
    for (const command of [
      "rg -n 'API_KEY' --glob '*.ts'",
      "rg -g '*.{ts,tsx}' token src",
      "grep -rn --include='*.md' token .",
    ]) {
      expect(isShareCredentialCommand(command, roots), command).toBe(false);
    }
    for (const command of ["rg -g '*.json' KEY", "rg -g '.env.ts' KEY", 'grep -rn KEY .']) {
      expect(isShareCredentialCommand(command, roots), command).toBe(true);
    }
  });
});

describe('templates and public keys', () => {
  const roots = ['/repo'];

  it('are not credentials, unless they sit in a credential folder', () => {
    for (const target of [
      '/repo/.env.example',
      '/repo/apps/web/.env.sample',
      '/repo/.ENV.TEMPLATE',
      '/repo/deploy/id_rsa.pub',
      '/repo/keys/server.key.pub',
      'C:\\repo\\id_ed25519.pub',
    ]) {
      expect(isShareCredentialPath(target), target).toBe(false);
      // 本机规则不变。
      expect(isSensitiveCredentialPath(target), target).toBe(true);
    }
    for (const target of [
      '/home/me/.ssh/id_rsa.pub',
      'C:\\Users\\me\\.ssh\\id_rsa.pub',
      '/repo/.env.example.local',
      '/repo/deploy/id_rsa.pub.bak',
      '/repo/.env',
      '/repo/deploy/id_rsa',
    ]) {
      expect(isShareCredentialPath(target), target).toBe(true);
    }
  });

  it('can be read by commands', () => {
    for (const command of ['cat .env.example', 'head -5 apps/web/.env.sample', 'cat deploy/id_rsa.pub', "rg -g '.env.example' KEY"]) {
      expect(isShareCredentialCommand(command, roots), command).toBe(false);
      expect(shellCommandReadsCredentials(command, roots), command).toBe(true);
    }
    for (const command of ['cat ~/.ssh/id_rsa.pub', 'cat .env.example .env', 'cat id_rsa.pub id_rsa']) {
      expect(isShareCredentialCommand(command, roots), command).toBe(true);
    }
  });
});

describe('shareCredentialGitReads', () => {
  const roots = ['/repo'];

  it('hands over git commands that need confirmation only because they show content', () => {
    expect(shareCredentialGitReads('git log -p -- src/app.ts', roots, { cwd: '/repo' })).toMatchObject([
      { sub: 'log', args: ['-p', '--', 'src/app.ts'] },
    ]);
    expect(shareCredentialGitReads('git diff && git show HEAD', roots, { cwd: '/repo' })).toHaveLength(2);
    expect(shareCredentialGitReads('git status', roots, { cwd: '/repo' })).toMatchObject([
      { sub: 'status', metadataOnly: true },
    ]);
    expect(shellCommandReadsCredentials('git status', roots)).toBe(false);
    // 还有别的理由，或本来就不用确认：不交给核实。
    expect(shareCredentialGitReads('git diff && cat .env', roots, { cwd: '/repo' })).toBeNull();
    expect(shareCredentialGitReads('git show HEAD:.env', roots, { cwd: '/repo' })).toBeNull();
    expect(shareCredentialGitReads('pnpm test', roots, { cwd: '/repo' })).toBeNull();
  });

  it('hands over git commands that print the git config, but not ones that print saved logins', () => {
    for (const command of ['git remote -v', 'git config --list', 'git config --get remote.origin.url']) {
      expect(isShareCredentialCommand(command, roots, { cwd: '/repo' }), command).toBe(true);
      expect(shareCredentialGitReads(command, roots, { cwd: '/repo' }), command).toHaveLength(1);
    }
    for (const command of ['git credential fill', 'git credential-osxkeychain get', 'git remote -v && cat .env']) {
      expect(isShareCredentialCommand(command, roots, { cwd: '/repo' }), command).toBe(true);
      expect(shareCredentialGitReads(command, roots, { cwd: '/repo' }), command).toBeNull();
    }
  });

  it('does not exempt git reads that override the config source', () => {
    for (const command of [
      'git -c include.path=/tmp/secret-config config --list',
      'git --config-env include.path=GIT_INCLUDE_PATH config --list',
      'git diff $(git add -A)',
    ]) {
      expect(isShareCredentialCommand(command, roots, { cwd: '/repo' }), command).toBe(true);
      expect(shareCredentialGitReads(command, roots, { cwd: '/repo' }), command).toEqual(
        expect.arrayContaining([expect.objectContaining({ priorSegmentsMayMutate: true })]),
      );
    }
  });

  it('keeps dynamically constructed xargs and parallel commands behind confirmation', () => {
    for (const command of [
      'printf item | xargs git diff',
      'xargs sh -c "git diff"',
      'find . -print0 | parallel -0 git diff',
      "env -S 'git diff'",
      "env --split-string='git diff'",
      'echo "$(git diff)"',
      'cat <(git diff)',
      "sh -c 'git diff'",
      "find . -exec sh -c 'git diff' {} \\;",
      "python -c 'git diff'",
      "node -e 'git diff'",
      "eval 'git diff'",
      "awk 'BEGIN { system(\"git diff\") }'",
      "perl -e 'system(\"git diff\")'",
      "bash -lc 'git diff'",
      "sh -xec 'git diff'",
      "bash --command='git diff'",
      'echo "$(git.exe diff)"',
    ]) {
      expect(isShareCredentialCommand(command, roots, { cwd: '/repo' }), command).toBe(true);
      expect(shareCredentialGitReads(command, roots, { cwd: '/repo' }), command).toBeNull();
    }
  });
});

describe('secrets written in the command', () => {
  const roots = ['/repo'];
  const token = ['ghp_', '0123456789abcdefghijABCDEFGHIJ012345'].join('');

  it('need confirmation, only in shared provider tasks', () => {
    for (const command of [
      `git remote set-url origin https://me:${token}@github.com/a/b.git`,
      'git clone https://oauth2:'
        + ['glpat-', 'AbCdEfGhIjKlMnOpQrSt'].join('')
        + '@gitlab.com/a/b.git',
      `git push https://${token}@github.com/a/b.git`,
      `git -c http.extraHeader="Authorization: Bearer ${token}" pull`,
      'git log -S ' + ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
      `curl -H "Authorization: token ${token}" https://api.github.com/user`,
      'psql postgres://app:hunter2secret@db.internal/app',
      // <提交>:<路径> 写出以点开头的凭证类文件，scp 式地址同理。
      'git show HEAD:.aws/credentials',
      'git show main:.npmrc',
      'scp build-host:.npmrc .',
    ]) {
      expect(isShareCredentialCommand(command, roots), command).toBe(true);
      expect(shareCredentialGitReads(command, roots), command).toBeNull();
      // 本机规则不变。
      expect(shellCommandReadsCredentials(command, roots), command).toBe(false);
    }
  });

  it('leave ordinary addresses and words alone', () => {
    for (const command of [
      'git clone git@github.com:a/b.git',
      'git clone https://github.com/a/b.git',
      'git push origin main',
      'git commit -m "fix sk-learn import"',
      'curl http://localhost:3000/api',
    ]) {
      expect(isShareCredentialCommand(command, roots), command).toBe(false);
    }
    for (const command of ["git log --format='%h: %s' -5", 'git show HEAD:src/app.ts', 'git show HEAD:.env.example']) {
      expect(textSpellsOutSecret(command), command).toBe(false);
      expect(shellCommandReadsCredentials(command, roots), command).toBe(command === 'git show HEAD:.env.example');
      expect(shareCredentialGitReads(command, roots, { cwd: '/repo' }), command).toMatchObject([
        { metadataOnly: true },
      ]);
    }
  });
});


describe('long development commands', () => {
  describe.each([false, true])('shared gate with path resolver: %s', (withResolver) => {
    it.each([500, 1000, 2000, 4000])('scans %i small segments in under a second and still checks the tail', (count) => {
      const prefix = 'echo a;'.repeat(count);
      const resolveFilePath = vi.fn((operand: string, cwd: string) => `${cwd}/${operand}`);
      const opts = {
        cwd: '/repo',
        ...(withResolver ? { resolveFilePath } : {}),
      };
      for (const [tail, expected] of [['echo done', false], ['cat README.md', false], ['cat .env', true], ['cat ~/.ssh/id_rsa', true]] as const) {
        const start = performance.now();
        expect(isShareCredentialCommand(prefix + tail, ['/repo'], opts), tail).toBe(expected);
        expect(performance.now() - start, tail).toBeLessThan(1000);
      }
      if (withResolver) expect(resolveFilePath).toHaveBeenCalledOnce();
    });
  });

  it('scans beyond the model review budget without treating script length as a credential read', () => {
    const script = "python3 - <<'PY'\n" + '# ordinary edit\n'.repeat(500)
      + "p='main.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('true','false'))\nPY";
    expect(script.length).toBeGreaterThan(4096);
    const roots = ['/repo'];
    expect(isShareCredentialCommand(script + '\nnode --test main.test.mjs', roots)).toBe(false);
    expect(isShareCredentialCommand(script + '\ncat ~/.ssh/id_rsa', roots)).toBe(true);
    expect(isShareCredentialCommand(script + '\ncat .env', roots)).toBe(true);
  });
});
