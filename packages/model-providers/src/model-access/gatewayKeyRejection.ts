import { createHash } from 'node:crypto';
import type { ModelAccessCredentialSource } from '../modelAccess.js';

export interface GatewayKeyRejectionDeps {
  /** 当前会话是否允许使用 Cindy 网关(getAppCapabilities().canUseCindyGateway)。 */
  canUseCindyGateway(): boolean;
  /** 是否正处于账号切换边界(isAppSessionBoundaryPending)。 */
  isSessionBoundaryPending(): boolean;
  /** 本机 Key 的来源标记;只处理服务端下发('server')的 Key。 */
  getCredentialSource(): ModelAccessCredentialSource | null;
  /** 本机当前保存的 Cindy AI Key(providerSecretStore 'xd')。 */
  readCurrentKey(): string | null;
  /** 触发一次凭据同步(credentialsSync.resyncAfterKeyRejection())。 */
  requestSync(): Promise<unknown>;
  log?: {
    info(message: string): void;
    warn(message: string): void;
  };
  /** 当前时间(毫秒),默认 Date.now;测试注入假时钟。 */
  now?(): number;
}

/** 同一把 Key 两次触发同步之间的最短间隔。 */
export const CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS = 5 * 60_000;

/**
 * 上报器,两个入口:
 *  - `reportUsedKey`:调用方知道请求实际携带的 Key(规则 A + 规则 B,触发即记入
 *    `lastTriggered`);
 *  - `reportCurrentKey`:调用方不知道用的是哪把 Key(智能体回合终态)。当前 Key 在窗口内
 *    已被准确上报触发过,或已被本入口触发过,都跳过;本入口只记自己的
 *    `lastCurrentKeyTriggered`,**不写**准确上报的记录——否则旧 Key 进程(未重启的 Codex、
 *    老任务)的迟到 401 会占用新 Key 的触发机会,新 Key 真失效时准确上报反被忽略。单独记录
 *    则保证卡在旧 Key 上的任务对同一把当前 Key 每个窗口只多触发 1 次。
 */
export interface GatewayKeyRejectionReporter {
  reportUsedKey(usedKey: string | null | undefined): void;
  reportCurrentKey(): void;
}

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface TriggerRecord {
  fingerprint: string;
  at: number;
}

/** 组装一个上报器;内存里只保留上一次已触发 Key 的指纹与触发时间。 */
export function createGatewayKeyRejectionReporter(
  deps: GatewayKeyRejectionDeps,
): GatewayKeyRejectionReporter {
  const now = deps.now ?? Date.now;
  let lastTriggered: TriggerRecord | null = null;
  /** 只供 reportCurrentKey 读写;reportUsedKey 既不读也不写它。 */
  let lastCurrentKeyTriggered: TriggerRecord | null = null;

  /** 同一指纹且仍在窗口内(时钟回拨视为窗口已过,避免长时间卡住)。 */
  const triggeredRecently = (
    record: TriggerRecord | null,
    fingerprint: string,
    at: number,
  ): boolean => {
    if (!record || record.fingerprint !== fingerprint) return false;
    const elapsed = at - record.at;
    return elapsed >= 0 && elapsed < CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS;
  };

  const warn = (prefix: string, error: unknown): void => {
    deps.log?.warn(
      `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  /** 共同的跳过条件;通过时返回本机当前 Key。 */
  const currentServerKey = (): string | null => {
    if (!deps.canUseCindyGateway()) return null;
    if (deps.isSessionBoundaryPending()) return null;
    if (deps.getCredentialSource() !== 'server') return null;
    return deps.readCurrentKey() || null;
  };

  const triggerSync = (): void => {
    deps.log?.info('Cindy AI key rejected by gateway, re-syncing credentials');
    void deps.requestSync().catch((error: unknown) => {
      warn('Cindy AI credentials re-sync after key rejection failed', error);
    });
  };

  // 上报发生在各调用方的错误处理路径里,任何异常都不能改变调用方原有的失败语义。
  const guarded = (run: () => void): void => {
    try {
      run();
    } catch (error) {
      warn('Cindy AI key rejection report failed', error);
    }
  };

  return {
    reportUsedKey: (usedKey) =>
      guarded(() => {
        if (!usedKey) return;
        const currentKey = currentServerKey();
        // 规则 A:只认本机当前这把 Key 的拒绝。
        if (!currentKey || currentKey !== usedKey) return;
        // 规则 B:同一把 Key 在窗口内最多触发一次。
        const fingerprint = keyFingerprint(usedKey);
        const at = now();
        if (triggeredRecently(lastTriggered, fingerprint, at)) return;
        lastTriggered = { fingerprint, at };
        triggerSync();
      }),
    reportCurrentKey: () =>
      guarded(() => {
        const currentKey = currentServerKey();
        if (!currentKey) return;
        // 当前 Key 在窗口内已被准确上报或本入口同步过:不再重复请求。旧 Key 进程在当前 Key
        // 有效时会每轮失败,服务端每次都原样返回当前 Key,不单独记录就会每条消息都请求一次。
        const fingerprint = keyFingerprint(currentKey);
        const at = now();
        if (triggeredRecently(lastTriggered, fingerprint, at)) return;
        if (triggeredRecently(lastCurrentKeyTriggered, fingerprint, at)) return;
        lastCurrentKeyTriggered = { fingerprint, at };
        triggerSync();
      }),
  };
}
