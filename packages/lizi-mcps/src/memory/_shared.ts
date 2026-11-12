/**
 * memory/_shared.ts
 *
 * 共享 helpers:
 *  - buildJsonResult: 拼成单 text MemoryToolResult, 跟 scheduler/_shared 同形
 *  - withStore:       拿 per-workdir MakerMemoryStore, 自动 try/catch + 错误翻译
 *
 * MakerMemoryManager 通过 deps.getManager() lazy 拿 (跟 scheduler 同模式),
 * manager 自身可能在用户切 mode/账号时被替换, 不能持长生命周期引用。
 *
 * deps.workdir 是 MCP server 工厂里的 fallback。Codex HTTP bridge 初始化期拿到
 * 的是全局空 ctx，所以 tool call 时优先通过 deps.getSessionContext() 读取当前
 * thread 的真实 workingDir。
 */

import { z } from 'zod';

import {
  MemoryError,
  resolveMemoryScopeKey,
  type MakerMemoryManager,
  type MakerMemoryStore,
} from '@cindy/maker-core';

import type { MemoryToolResult } from '../cindy_memoryToolRegistry.js';
import type { MemoryMcpDeps } from '../types.js';
import { classifyMemoryError } from './errors.js';

export function buildJsonResult(payload: unknown, isError = false): MemoryToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 拿当前 session 绑定 workdir 的 Store. manager 不可用 (没注入 / disabled) 时
 * 返 MAKER_MEMORY_NOT_READY 错误, 调用方按 plan 决定是否提示用户开 mode。
 */
export type WithStoreContext = {
  store: MakerMemoryStore;
  /** 解析后的 session scope key (已归一到仓库根)。 */
  scopeKey: string;
  manager: MakerMemoryManager;
  /** 这次任务有哪几份记忆 (见 MakerMemoryManager.memoryScopesFor)。 */
  scopes: { user: string | null; project: string | null };
  /** 打开其中一份; 这次任务没有那一份时返回 null。 */
  open(scope: MemoryScopeName): Promise<MakerMemoryStore | null>;
};

/**
 * 普通任务有两份记忆: `user` 关于用户本人、每个项目都生效; `project` 只属于当前
 * 仓库或目录。伙伴和一次性对话只有一份, 传了 scope 也落在那一份上。
 */
export type MemoryScopeName = 'user' | 'project';
const SCOPE_NAMES: readonly MemoryScopeName[] = ['project', 'user'];

export const memoryScopeArg = z
  .enum(['user', 'project'])
  .optional()
  .describe('哪一份记忆: user = 关于用户本人、每个项目都生效; project = 只属于当前仓库或目录');

async function holds(store: MakerMemoryStore, filename: string): Promise<boolean> {
  try {
    await store.read(filename);
    return true;
  } catch (err) {
    if (err instanceof MemoryError && err.code === 'not-found') return false;
    throw err;
  }
}

/**
 * 新条目写到哪一份: 调用方指定的优先; 没指定时 `user` 类进账号级, 其余进项目。
 * 这次任务没有那一份 (伙伴 / 一次性对话) 就落在仅有的那一份上。
 */
export async function storeForNew(
  ctx: WithStoreContext,
  scope: MemoryScopeName | undefined,
  type: string,
): Promise<{ store: MakerMemoryStore; scope: MemoryScopeName }> {
  const wanted = scope ?? (type === 'user' ? 'user' : 'project');
  const name = ctx.scopes[wanted] ? wanted : wanted === 'user' ? 'project' : 'user';
  return { store: (await ctx.open(name))!, scope: name };
}

/**
 * 已有文件在哪一份。没指定 scope 时两份都找: 只在一份里就用那一份; 两份都没有时
 * 落到第一份, 让后续操作按原样报 NOT_FOUND; 两份都有时要求调用方指明。
 */
export async function storeHolding(
  ctx: WithStoreContext,
  filename: string,
  scope?: MemoryScopeName,
): Promise<{ store: MakerMemoryStore; scope: MemoryScopeName }> {
  const names = SCOPE_NAMES.filter((name) => ctx.scopes[name] && (!scope || name === scope));
  const candidates = names.length > 0 ? names : SCOPE_NAMES.filter((name) => ctx.scopes[name]);
  const found: Array<{ store: MakerMemoryStore; scope: MemoryScopeName }> = [];
  let first: { store: MakerMemoryStore; scope: MemoryScopeName } | null = null;
  for (const name of candidates) {
    const store = (await ctx.open(name))!;
    first ??= { store, scope: name };
    if (candidates.length === 1) return first;
    if (await holds(store, filename)) found.push({ store, scope: name });
  }
  if (found.length > 1) {
    throw new MemoryError(
      'invalid-filename',
      `${filename} 在 user 和 project 两份记忆里都有; 传 scope 指明要操作哪一份`,
    );
  }
  return found[0] ?? first!;
}

export async function withStore(
  deps: MemoryMcpDeps,
  fn: (store: MakerMemoryStore, ctx: WithStoreContext) => Promise<unknown>,
): Promise<MemoryToolResult> {
  let store: MakerMemoryStore;
  let manager: MakerMemoryManager;
  let scopeKey: string;
  let scopes: WithStoreContext['scopes'];
  let scopeAtEntry: string | null = null;
  try {
    manager = deps.getManager();
    const ctx = deps.getSessionContext?.();
    // Bot scope comes from the host-bound session, never tool arguments. Use
    // the manager's independent-scope policy, just like its getStore path.
    if (!manager.isEnabled(ctx?.memoryScopeKey)) {
      return buildJsonResult(
        { ok: false, code: 'MAKER_MEMORY_NOT_READY', message: 'maker memory disabled (mode != "maker")' },
        true,
      );
    }
    // 操作锚点 (review #2388 Codex 4th P1): getStore 返回的裸 store 在 manager
    // 守卫之外被调用方 await — 在拿 store 前捕获 scope, fn 完成后复核, 期间
    // 登出/切账号则操作结果不可信, fail-closed。
    scopeAtEntry = manager.currentOwnerScopeKey?.() ?? null;
    const workdir = ctx?.workingDir ?? deps.workdir;
    // SSH remote 会话 (ctx 带 remoteHostId) 的 workdir 是远端路径 — 经 scope
    // key 定位, 与 agent 启动注入 (claude-code/codex index.ts) 同一键规则;
    // 本地会话在此额外做 git worktree 归一化 (#2379)。已注入的 memoryScopeKey
    // (含 bot: / ssh:) 原样透传, 不再二次解析。
    scopeKey =
      ctx?.memoryScopeKey ?? (await resolveMemoryScopeKey(workdir, ctx?.remoteHostId));
    // git 探测是 await: 期间 logout / 切账号会换 owner, 甚至换掉 getManager()
    // 绑定的 manager。必须在 getStore 前按入口 scope 复核, 否则会把解析到的
    // key 开到新 owner 的池里 (Codex #2399 P1, 对齐 manager.getStore 的
    // scopeAtEntry + assertScopeUnchanged)。
    manager = deps.getManager();
    if (scopeAtEntry !== null && manager.currentOwnerScopeKey?.() !== scopeAtEntry) {
      return buildJsonResult(
        {
          ok: false,
          code: 'MAKER_MEMORY_NOT_READY',
          message: 'owner scope changed during async memory operation; aborting (retry against current scope)',
        },
        true,
      );
    }
    scopes = manager.memoryScopesFor(scopeKey);
    store = await manager.getStore(scopes.project ?? scopes.user!);
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
  try {
    const opened = manager;
    // 一次工具调用可能先后打开两份记忆 (账号级、项目)。每次打开都会按「当时」的账号
    // 重新绑定, 所以必须在每一次打开前按入口账号复核: 否则 A 账号发起的操作会在中途
    // 切换后落到 B 账号的同名文件上, 事后的最终复核只能报错、撤不回已经做完的删除。
    const open = async (scope: MemoryScopeName): Promise<MakerMemoryStore | null> => {
      const key = scopes[scope];
      if (!key) return null;
      if (scopeAtEntry !== null && deps.getManager().currentOwnerScopeKey?.() !== scopeAtEntry) {
        throw new MemoryError(
          'not-ready',
          'owner scope changed during async memory operation; aborting (retry against current scope)',
        );
      }
      return opened.getStore(key);
    };
    const data = await fn(store, { store, scopeKey, manager, scopes, open });
    // 操作后复核: owner 在 fn 执行期间切换 → 结果不可信, 不得按成功返回。
    if (scopeAtEntry !== null && deps.getManager().currentOwnerScopeKey?.() !== scopeAtEntry) {
      return buildJsonResult(
        {
          ok: false,
          code: 'MAKER_MEMORY_NOT_READY',
          message: 'owner scope changed during memory operation; result not trusted',
        },
        true,
      );
    }
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
}
