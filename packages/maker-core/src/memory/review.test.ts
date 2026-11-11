/**
 * MakerMemoryManager.runReview 的 reviewOneShot 注入与回退语义回归。
 *
 * 背景: review agent (claude-code) 的默认模型 claude-haiku-4-5 在部分供应商网关上
 * 不在账号可用清单内(403 user_model_access_denied), 硬编码默认路由会让 memory_review
 * 对这些账号 100% 失败。manager 新增可选 reviewOneShot 注入点: host(desktop)走共享
 * 辅助模型链; 注入后链上没产出(null/空串)必须 fail-closed 成可读原因, 不得回退
 * 默认路由。未注入的宿主保持既有默认路由行为不变。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseAgent } from '../agents/base-agent.js';
import type { Logger } from '../interfaces/logger.js';
import { MakerMemoryManager, type MakerMemoryManagerDeps } from './manager.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

const WORKDIR = '/repo/workdir';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'memory-review-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sqliteFactory = (filePath: string): Database.Database => new DatabaseCtor(filePath);

function fakeAgent(text: string): BaseAgent {
  return { oneShot: vi.fn(async () => text) } as unknown as BaseAgent;
}

async function makeManager(
  agents: Partial<Record<string, BaseAgent>>,
  reviewOneShot?: MakerMemoryManagerDeps['reviewOneShot'],
): Promise<MakerMemoryManager> {
  const manager = new MakerMemoryManager({
    basePath: root,
    sqliteFactory,
    agents,
    logger: noopLogger,
    initialEnabled: true,
    ownerScopeKey: () => 'test:owner:1',
    reviewOneShot,
  });
  await manager.write(WORKDIR, {
    type: 'user', name: 'pref', title: 'Preference',
    description: 'Durable preference', body: 'Keep this preference.',
  });
  return manager;
}

describe('MakerMemoryManager.runReview · reviewOneShot 注入与回退', () => {
  it('uses the injected reviewOneShot and does not touch the default agent route', async () => {
    const agent = fakeAgent('default-route suggestion');
    const reviewOneShot = vi.fn(async () => 'utility-chain suggestion');
    const manager = await makeManager({ 'claude-code': agent }, reviewOneShot);
    try {
      const result = await manager.runReview(WORKDIR);
      expect(result.suggestions).toBe('utility-chain suggestion');
      expect(reviewOneShot).toHaveBeenCalledTimes(1);
      // 注入生效时默认路由一次都不该被调用(它正是 403 的那条)。
      expect(agent.oneShot).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('forwards the review budget to the injected call', async () => {
    const reviewOneShot = vi.fn(async () => 'ok');
    const manager = await makeManager({}, reviewOneShot);
    try {
      await manager.runReview(WORKDIR);
      expect(reviewOneShot).toHaveBeenCalledWith(expect.any(String), { maxTokens: 800, timeoutMs: 60_000 });
    } finally {
      manager.dispose();
    }
  });

  it('fails closed with a readable reason when the chain yields null', async () => {
    const agent = fakeAgent('default-route suggestion');
    const manager = await makeManager({ 'claude-code': agent }, async () => null);
    try {
      // 回退默认路由只会落到硬编码 claude-haiku-4-5, 对无 Anthropic 权限的账号
      // 必然 403(2026-10-14 实测) — 不得回退, 必须点名真实原因。
      await expect(manager.runReview(WORKDIR)).rejects.toThrow(/auxiliary model chain produced no text/);
      expect(agent.oneShot).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('fails closed when the chain yields only whitespace', async () => {
    const agent = fakeAgent('default-route suggestion');
    const manager = await makeManager({ 'claude-code': agent }, async () => '   \n  ');
    try {
      await expect(manager.runReview(WORKDIR)).rejects.toThrow(/auxiliary model chain produced no text/);
      expect(agent.oneShot).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('keeps the historical default route when no reviewOneShot is injected', async () => {
    const agent = fakeAgent('default-route suggestion');
    const manager = await makeManager({ 'claude-code': agent });
    try {
      const result = await manager.runReview(WORKDIR);
      expect(result.suggestions).toBe('default-route suggestion');
      expect(agent.oneShot).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it('still short-circuits with no records to review', async () => {
    const manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory,
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
      ownerScopeKey: () => 'test:owner:1',
      reviewOneShot: vi.fn(async () => 'should not run'),
    });
    try {
      const result = await manager.runReview('/repo/empty');
      expect(result.suggestions).toBe('No memories in this workdir yet.');
    } finally {
      manager.dispose();
    }
  });

  it('fails closed when the account switches during the injected call (no cross-account send)', async () => {
    // Greptile P1 回归: 辅助链 await 横跨账号边界时链会中止并返回 null, 若此时
    // 直接回落默认路由, 旧 owner 的 dump 会经新账号凭据发出且不可撤回。任一分支
    // 出发前必须复核 scope 并抛出, 默认路由一次都不被调用。
    const agent = fakeAgent('default-route suggestion');
    let scope = 'test:owner:1';
    const manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory,
      agents: { 'claude-code': agent },
      logger: noopLogger,
      initialEnabled: true,
      ownerScopeKey: () => scope,
      reviewOneShot: async () => {
        scope = 'test:owner:2'; // 链等待期间用户切换账号
        return null;
      },
    });
    await manager.write(WORKDIR, {
      type: 'user', name: 'pref', title: 'Preference',
      description: 'Durable preference', body: 'Keep this preference.',
    });
    try {
      await expect(manager.runReview(WORKDIR)).rejects.toThrow(/owner scope/i);
      expect(agent.oneShot).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });
});
