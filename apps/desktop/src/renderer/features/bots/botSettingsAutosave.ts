/**
 * botSettingsAutosave — Bot 设置页「静默自动保存」的纯逻辑内核。
 *
 * 背景:设置页原本是「改完自己点底部保存条」,实测里用户根本不知道有保存这回事,
 * 改了好几轮全部丢掉。裁决是**用户不该知道有保存这回事**:改动自动落库,保存条删除。
 *
 * 本文件只负责调度与脏检查语义,不碰 React,也不碰 IPC —— 这样可以用 fake timers
 * 直接测「burst 合并成一次」「无变化不发 IPC」「离开时冲刷」「失败可重试」,而不必
 * 挂载整个设置页。React 侧的粘合在 useBotSettingsAutosave.ts。
 *
 * 核心语义:
 *  - schedule('text'):文本输入,防抖(每次调用重置计时)。连续打字期间永不提交。
 *  - schedule('instant'):开关 / 下拉 / 头像等离散选择,**走同一条合并通道**但用极短
 *    窗口(默认 0ms),同一 tick 的连续切换仍并成一次提交。已有 instant 在等时,
 *    后续的 'text' 不再把计时推后 —— 离散选择要求尽快落库,顺路带上刚打的字即可。
 *  - 脏检查:提交前把「当前归一化快照」与「上次成功保存的快照」深比较,相等直接
 *    返回 idle,不发 IPC。主进程侧虽然内容未变不会升版本,但白发一次 IPC 仍是噪音。
 *  - 串行化:同一时刻只有一次提交在途。计时到期撞上在途提交时**等它结束再重判脏**
 *    (trailing save),而不是丢弃 —— 否则最后一批修改会悬挂到用户下次输入。
 *  - flush():显式边界(blur / 返回聊天)冲刷,返回可 await 的 Promise。
 *  - flushDetached():卸载 / 切 bot 时冲刷。同步发出 IPC 后立刻返回,并停止一切状态
 *    回调(组件已经不在了)。
 */

import type { BotCapabilities } from './botStore';

/** 提交给 `updateBotProfile` 的字段集合(与手动保存时的载荷完全一致)。 */
export interface BotSettingsPayload {
  name: string;
  description: string;
  identitySource: string;
  userContextSource: string;
  avatar: string;
  avatarColor: string;
  capabilities: BotCapabilities;
  skills: string[];
}

/** 设置页里被编辑的原始表单值(未做 trim / 兜底)。 */
export interface BotSettingsDraft {
  name: string;
  description: string;
  identitySource: string;
  userContextSource: string;
  avatar: string;
  avatarColor: string;
  capabilities: BotCapabilities;
  skills: string[];
}

/**
 * 归一化成待提交载荷。
 *
 * `fallbackName` 沿用手动保存时的兜底:名字被清空时提交 bot 现有名字,而不是空串。
 * 归一化必须是「基线」与「当前值」共用的同一个函数 —— 否则挂载瞬间
 * `description` 前后有空格就会被判成脏,页面一打开就白写一次(归档 bot 尤其不能写)。
 */
export function normalizeBotSettingsPayload(
  draft: BotSettingsDraft,
  fallbackName: string,
): BotSettingsPayload {
  return {
    name: draft.name.trim() || fallbackName,
    description: draft.description.trim(),
    identitySource: draft.identitySource,
    userContextSource: draft.userContextSource,
    avatar: draft.avatar,
    avatarColor: draft.avatarColor,
    capabilities: draft.capabilities,
    skills: draft.skills,
  };
}

function stringListEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 比较 capabilities。按 key 并集遍历而不是逐字段写死:`BotCapabilities` 后续加字段
 * 时脏检查会自动覆盖,否则新字段会静默永远「不脏」,改了不保存 —— 正是本次要修的病。
 * `providerId` 允许 `null` 与 `undefined` 混用,两者视为同一个「没有」,避免仅因
 * 来源不同(store 归一化 vs 本地 state)产生幻影脏。
 */
export function botCapabilitiesEqual(a: BotCapabilities, b: BotCapabilities): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || !stringListEqual(left, right)) {
        return false;
      }
      continue;
    }
    if ((left ?? null) !== (right ?? null)) return false;
  }
  return true;
}

export function botSettingsPayloadEqual(a: BotSettingsPayload, b: BotSettingsPayload): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.identitySource === b.identitySource &&
    a.userContextSource === b.userContextSource &&
    a.avatar === b.avatar &&
    a.avatarColor === b.avatarColor &&
    stringListEqual(a.skills, b.skills) &&
    botCapabilitiesEqual(a.capabilities, b.capabilities)
  );
}

/** 自动保存对用户可见的状态。`saved` 由 UI 侧短暂显示后淡出,不常驻。 */
export type BotAutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** 触发来源:文本输入走防抖,离散选择(开关 / 下拉 / 头像)走即时合并窗口。 */
export type BotAutosaveTrigger = 'text' | 'instant';

export interface BotSettingsAutosaveOptions {
  /** 文本输入的防抖窗口,默认 1200ms。 */
  textDelayMs?: number;
  /** 离散选择的合并窗口,默认 0ms(同一 tick 的连续切换仍并成一次)。 */
  instantDelayMs?: number;
  /** 读取当前归一化快照。 */
  readPayload: () => BotSettingsPayload;
  /** 读取上次成功保存的快照(基线)。成功提交后由 commit 侧推进。 */
  readBaseline: () => BotSettingsPayload;
  /** 真正提交(IPC)。resolve = 已落库(此时 commit 侧应已推进基线);reject = 失败。 */
  commit: (payload: BotSettingsPayload) => Promise<void>;
  /** 状态变化回调。dispose 之后不再触发。 */
  onStatusChange?: (status: BotAutosaveStatus) => void;
}

export interface BotSettingsAutosaveHandle {
  /** 字段变化时调用,把这次变化并入待提交 burst。 */
  schedule(trigger: BotAutosaveTrigger): void;
  /** 显式边界冲刷(blur / 返回聊天)。无变化时是 no-op。 */
  flush(): Promise<void>;
  /** 失败后重发。等价于一次立即 flush。 */
  retry(): Promise<void>;
  /** 卸载 / 切 bot:同步发出未落的提交并停止状态回调。幂等。 */
  flushDetached(): void;
  /** 取消未触发的计时,不提交。 */
  cancel(): void;
  /** 是否有已改但未落库的内容。 */
  isDirty(): boolean;
}

export function createBotSettingsAutosave(
  options: BotSettingsAutosaveOptions,
): BotSettingsAutosaveHandle {
  const textDelayMs = options.textDelayMs ?? 1200;
  const instantDelayMs = options.instantDelayMs ?? 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 是否有「离散选择」在等 —— 它不允许被后续文本输入推后。 */
  let instantPending = false;
  let inFlight: Promise<void> | null = null;
  let detached = false;

  const emit = (status: BotAutosaveStatus): void => {
    if (detached) return;
    options.onStatusChange?.(status);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    instantPending = false;
  };

  const isDirty = (): boolean =>
    !botSettingsPayloadEqual(options.readPayload(), options.readBaseline());

  const runNow = async (): Promise<void> => {
    clearTimer();
    if (inFlight) {
      // 撞上在途提交:等它结束再重判脏(trailing save),不丢这一批修改。
      await inFlight.catch(() => undefined);
    }
    if (detached) return;
    const payload = options.readPayload();
    if (botSettingsPayloadEqual(payload, options.readBaseline())) {
      // 无实际变化 —— 不发 IPC。
      return;
    }
    emit('saving');
    // 从这里到 `inFlight = attempt` 之间没有 await,不会有第二个 runNow 插进来
    // 看到 inFlight 为 null 而重复提交同一份 payload。
    const attempt = (async () => {
      try {
        await options.commit(payload);
        emit(isDirty() ? 'idle' : 'saved');
      } catch {
        emit('error');
      }
    })();
    inFlight = attempt;
    await attempt;
    if (inFlight === attempt) inFlight = null;
  };

  const fire = (): void => {
    timer = null;
    instantPending = false;
    void runNow();
  };

  return {
    schedule(trigger) {
      if (detached) return;
      if (trigger === 'instant') {
        if (timer !== null) clearTimeout(timer);
        instantPending = true;
        timer = setTimeout(fire, instantDelayMs);
        return;
      }
      // 已有离散选择在等:让它按原定时刻提交,顺路带上刚输入的文本。
      if (instantPending) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, textDelayMs);
    },
    flush() {
      if (detached) return Promise.resolve();
      return runNow();
    },
    retry() {
      if (detached) return Promise.resolve();
      return runNow();
    },
    flushDetached() {
      if (detached) return;
      clearTimer();
      const payload = options.readPayload();
      const dirty = !botSettingsPayloadEqual(payload, options.readBaseline());
      // 先断开状态回调:组件正在卸载,任何 setState 都是无主的。
      detached = true;
      if (!dirty) return;
      if (inFlight) {
        // 在途提交发的是更早的快照,不能拿它当「已落库」。等它结束后补发一次,
        // 否则「改完立刻返回聊天」这一下正好撞上在途保存就会丢最后一批修改。
        void inFlight
          .catch(() => undefined)
          .then(() => {
            const trailing = options.readPayload();
            if (botSettingsPayloadEqual(trailing, options.readBaseline())) return;
            return options.commit(trailing).catch(() => undefined);
          });
        return;
      }
      void options.commit(payload).catch(() => undefined);
    },
    cancel() {
      clearTimer();
    },
    isDirty,
  };
}
