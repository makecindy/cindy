/**
 * memory-hub-analysis-scheduler — P4 后台主动分析。
 *
 * memory-hub-plan.md §4 (P4): delta 触发 + 空闲检测 + 频率上限 + 设置开关。
 *  - delta: 自上次分析以来 memory_events 新增 >= DELTA_THRESHOLD 条才跑。
 *  - 空闲: 最近 10 分钟内有记忆写入 = 会话活跃, 本轮跳过 (记忆写入是
 *    会话活动的低噪代理, 不需要枚举 live session)。
 *  - 频率上限: 每 scope 两次分析至少间隔 MIN_INTERVAL_MS (7 天)。
 *  - 开关: memory-hub-settings.json 的 backgroundAnalysis, 关闭即完全停跑。
 *
 * 只产出缓存的分析视图, 不写任何记忆 (§12: AI 只建议不执行)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { MakerMemoryManager } from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  runMemoryHubAiAnalysisForStore,
  type MemoryHubAiAnalysisResult,
} from './memory-hub-ai-analysis.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import type { Maker } from '@cindy/maker-core';

const log = desktopMakerLogger.child('memory-hub-analysis-scheduler');

const TICK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;
const MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DELTA_THRESHOLD = 5;
const BUSY_WINDOW_MS = 10 * 60 * 1000;
/** 冷启动 (从未分析过) 的最低条目数 — 太小的语料不值得花一次 API 额度。 */
const MIN_ENTRIES_FOR_FIRST_RUN = 10;

export interface MemoryHubAnalysisStateFile {
  byScope: Record<
    string,
    { lastAnalysisAt: string; cached: MemoryHubAiAnalysisResult | null }
  >;
}

function stateFilePath(rootPath?: string): string {
  const root = rootPath ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : app.getPath('userData'));
  return path.join(root, 'memory-hub-analysis-state.json');
}

export function readMemoryHubAnalysisState(rootPath?: string): MemoryHubAnalysisStateFile {
  try {
    const raw = fs.readFileSync(stateFilePath(rootPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MemoryHubAnalysisStateFile>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.byScope !== 'object') {
      return { byScope: {} };
    }
    return { byScope: parsed.byScope };
  } catch {
    return { byScope: {} };
  }
}

export function writeMemoryHubAnalysisState(
  state: MemoryHubAnalysisStateFile,
  rootPath?: string,
): void {
  const file = stateFilePath(rootPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('memory hub analysis state persist failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getCachedMemoryHubAiAnalysis(
  scopeKey: string,
  rootPath?: string,
): MemoryHubAiAnalysisResult | null {
  return readMemoryHubAnalysisState(rootPath).byScope[scopeKey]?.cached ?? null;
}

/**
 * 手动触发与后台 tick 共用的缓存写路径。所有写入进同一进程内串行队列
 * (main 单进程; manual 按钮与后台 tick 可能并发, 各自整文件读改写会互相覆盖),
 * 配合 writeMemoryHubAnalysisState 的 tmp+rename 原子落盘, 不会丢对方的
 * lastAnalysisAt / 缓存 (review: 并发分析丢失缓存状态)。
 */
let stateWriteQueue: Promise<void> = Promise.resolve();

export function cacheMemoryHubAiAnalysis(
  scopeKey: string,
  result: MemoryHubAiAnalysisResult,
  rootPath?: string,
): void {
  stateWriteQueue = stateWriteQueue.then(() => {
    const state = readMemoryHubAnalysisState(rootPath);
    state.byScope[scopeKey] = { lastAnalysisAt: result.generatedAt, cached: result };
    writeMemoryHubAnalysisState(state, rootPath);
  });
}

export function startMemoryHubBackgroundAnalysis(deps: {
  maker: Maker;
  getManager: () => MakerMemoryManager | null | undefined;
  isBackgroundAnalysisEnabled: () => boolean;
}): () => void {
  let running = false;
  const timer = setInterval(() => {
    void runTick();
  }, TICK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const initial = setTimeout(() => {
    void runTick();
  }, INITIAL_DELAY_MS);
  if (typeof initial.unref === 'function') initial.unref();

  async function runTick(): Promise<void> {
    if (running) return;
    if (!deps.isBackgroundAnalysisEnabled()) return;
    running = true;
    try {
      const manager = deps.getManager();
      if (!manager || !manager.isEnabled()) return;
      const scopes = await manager.listScopes();
      const state = readMemoryHubAnalysisState();
      for (const scope of scopes) {
        if (!scope.scopeKey || scope.kind !== 'local') continue;
        const previous = state.byScope[scope.scopeKey] ?? null;
        const lastAnalysisAt = previous?.lastAnalysisAt ?? null;
        if (
          lastAnalysisAt !== null &&
          Date.now() - new Date(lastAnalysisAt).getTime() < MIN_INTERVAL_MS
        ) {
          continue;
        }
        try {
          const store = await manager.getStore(scope.scopeKey);
          const entries = await store.list();
          if (entries.length === 0) continue;
          if (lastAnalysisAt === null && entries.length < MIN_ENTRIES_FOR_FIRST_RUN) continue;
          if (
            lastAnalysisAt !== null &&
            !(await store.shouldTriggerBackgroundAnalysis(DELTA_THRESHOLD, lastAnalysisAt))
          ) {
            continue;
          }
          const recentEvents = await store.recentEvents(1);
          const latestEventTs = recentEvents[0]?.ts;
          if (
            latestEventTs &&
            Date.now() - new Date(latestEventTs).getTime() < BUSY_WINDOW_MS
          ) {
            continue;
          }
          const result = await runMemoryHubAiAnalysisForStore({
            maker: deps.maker,
            store,
            source: 'background',
            log,
          });
          if (result) {
            cacheMemoryHubAiAnalysis(scope.scopeKey, result);
            log.info('memory hub background analysis completed', {
              scopeKey: scope.scopeKey,
              recommendations: result.recommendations.length,
            });
          }
        } catch (err) {
          log.warn('memory hub background analysis scope failed', {
            scopeKey: scope.scopeKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn('memory hub background analysis tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  }

  return () => {
    clearInterval(timer);
    clearTimeout(initial);
  };
}
