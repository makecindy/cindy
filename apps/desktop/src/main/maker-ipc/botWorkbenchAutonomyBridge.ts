/**
 * 伙伴工具层 ↔ 宿主观察层(bot-autonomy)的窄接口。
 *
 * 观察层在启动时调用 `registerBotAutonomyReader` 注册;工具层(工作台、任务摘要)只经这里读,
 * 不直接 import 观察层,避免任务 IPC 一引用工具就把观察层的定时器与远程轮询带进来。
 * 未注册(观察层未启动 / 账号切换中)时:总调度查不到 → 一律按「不是总调度」(fail closed),
 * 「一眼」与状态行返回 null。
 */
import type { BotGlance, WatchedSession } from '../../shared/botAutonomy.js';

export interface BotAutonomyReader {
  /** 某个伙伴的「一眼」投影。 */
  glance(botId: string): Promise<BotGlance | null> | BotGlance | null;
  /** 当前总调度伙伴 id(「自动跟进所有任务」);没有总调度为 null。 */
  schedulerBotId(): Promise<string | null> | string | null;
  /** 状态表里的一行;本机为裸 id,另一台电脑为 deviceId::sessionId。 */
  watched(sessionId: string): WatchedSession | null | undefined;
}

let reader: BotAutonomyReader | null = null;

/** 观察层启动时注册,停止时传 null 注销。 */
export function registerBotAutonomyReader(next: BotAutonomyReader | null): void {
  reader = next;
}

export async function readBotGlance(botId: string): Promise<BotGlance | null> {
  if (!reader) return null;
  try {
    return (await reader.glance(botId)) ?? null;
  } catch {
    return null;
  }
}

export async function readSchedulerBotId(): Promise<string | null> {
  if (!reader) return null;
  try {
    return (await reader.schedulerBotId()) ?? null;
  } catch {
    return null;
  }
}

export function readWatchedSession(sessionId: string): WatchedSession | null {
  try {
    return reader?.watched(sessionId) ?? null;
  } catch {
    return null;
  }
}
