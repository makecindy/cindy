/**
 * 供应商分享的受邀者任务里「凭证类」的判定：沿用本机凭证规则，但配置目录里的说明类内容(Skill、
 * 子代理、命令、规则、个人说明)不算凭证。
 */
import { describe, expect, it } from 'vitest';

import { isShareCredentialCommand, isShareCredentialPath } from '../credentials';

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
});
