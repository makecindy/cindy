/**
 * feishu/events.ts
 * ---------------------------------------------------------------------------
 * Module-internal event bus for the feishu channel. Status / conflict events
 * are mirrored to the IPC bridge by `ipc.ts`; the message / cardAction events
 * are exposed to the host via `FeishuIM.onMessage` / `.onCardAction`.
 *
 * 每个 FeishuScope 一条总线(多份 bot 实例互不串线); `feishuEvents` 是指向当前
 * 作用域总线的转发器, 调用点写法不变。
 */

import { EventEmitter } from 'node:events';

import type {
  IMCardActionEvent,
  IMMessageEvent,
  IMStatus,
} from '../types.js';
import type { FeishuStatusUpdate } from './internal-types.js';
import { getScope } from './moduleScope.js';

export interface FeishuChannelEvents {
  // Internal status (broadcast to renderer via IPC).
  status: (update: FeishuStatusUpdate) => void;
  conflict: (payload: { appId: string }) => void;
  // Public IM events (consumed by host orchestrator via FeishuIM API).
  message: (event: IMMessageEvent) => void;
  cardAction: (event: IMCardActionEvent) => void;
  imStatus: (status: IMStatus) => void;
}

export class FeishuEventBus extends EventEmitter {
  override on<K extends keyof FeishuChannelEvents>(
    event: K,
    listener: FeishuChannelEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof FeishuChannelEvents>(
    event: K,
    listener: FeishuChannelEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof FeishuChannelEvents>(
    event: K,
    ...args: Parameters<FeishuChannelEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/** 当前作用域的事件总线(转发器)。 */
export const feishuEvents = {
  on<K extends keyof FeishuChannelEvents>(event: K, listener: FeishuChannelEvents[K]): FeishuEventBus {
    return getScope().events.on(event, listener);
  },
  off<K extends keyof FeishuChannelEvents>(event: K, listener: FeishuChannelEvents[K]): FeishuEventBus {
    return getScope().events.off(event, listener);
  },
  emit<K extends keyof FeishuChannelEvents>(
    event: K,
    ...args: Parameters<FeishuChannelEvents[K]>
  ): boolean {
    return getScope().events.emit(event, ...args);
  },
  removeAllListeners(event?: keyof FeishuChannelEvents): FeishuEventBus {
    return getScope().events.removeAllListeners(event);
  },
  listenerCount(event: keyof FeishuChannelEvents): number {
    return getScope().events.listenerCount(event);
  },
};
