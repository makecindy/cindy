/**
 * 伙伴对话输入框 → 伙伴 Profile 的运行时回写。
 *
 * 背景(裁决 2026-08-19):伙伴对话恢复显示模型选择器与权限 chip。这两个控件本来
 * 只写**会话行**(`sessions.model` / `.effort` / `.permissionMode` …),而伙伴的主
 * 任务会在 Renew 时按 Profile 的 `capabilities` **重建**一条新会话
 * (`local-db:bots:create-canonical-session`)。不回写 Profile 的话,用户在对话里
 * 选的模型会在 Renew 后悄悄跳回去 —— 「改了不持久」。
 *
 * 所以:凡是用户在伙伴对话里显式动过的运行时选择,都按同一份语义写回 Profile,
 * 和「设置 › 高级」里的那个 ModelSelector 走完全一样的通道(`updateBotProfile`),
 * 因此版本号的处理、pendingRenew 的判定都与既有行为一致,不新增第二套语义。
 *
 * 权限的映射与 main 侧 `botSessionPermissionMode` 互为逆运算:
 * `bypassPermissions` ⇄ `trusted`,其余一律 `ask`。
 *
 * 判定逻辑单独放在这个叶子模块里,方便直接单测 —— 调用点在 5k 行的
 * CCAgentSessionView 里,挂不起来。
 */
import type { BotCapabilities } from './botStore';

/** 一条会话行里与「引擎怎么跑」有关的字段(伙伴主任务重建时会用到的那些)。 */
export interface BotComposerRuntimeSnapshot {
  model?: string | null;
  providerId?: string | null;
  effort?: string | null;
  fastMode?: boolean | null;
  permissionMode?: string | null;
}

/** `capabilities` 里由输入框控件决定的子集。 */
export type BotComposerRuntimePatch = Pick<
  BotCapabilities,
  'model' | 'providerId' | 'effort' | 'fastMode' | 'permissions'
>;

/** session.permissionMode → capabilities.permissions(main 侧映射的逆运算)。 */
export function botPermissionsForSessionMode(mode: string | null | undefined): 'ask' | 'trusted' {
  return mode === 'bypassPermissions' ? 'trusted' : 'ask';
}

/**
 * 把一条会话快照折算成 Profile 的运行时子集。
 *
 * 缺字段一律回落到当前 capabilities —— 会话行还没回流(冷启动首帧、远程镜像
 * 在途)时不能把伙伴的模型清成空串。
 */
export function botComposerRuntimePatch(
  capabilities: BotCapabilities,
  snapshot: BotComposerRuntimeSnapshot,
): BotComposerRuntimePatch {
  const model = typeof snapshot.model === 'string' ? snapshot.model.trim() : '';
  const effort = typeof snapshot.effort === 'string' ? snapshot.effort.trim() : '';
  return {
    model: model || capabilities.model,
    providerId:
      typeof snapshot.providerId === 'string' && snapshot.providerId.trim()
        ? snapshot.providerId.trim()
        : snapshot.providerId === null
          ? null
          : (capabilities.providerId ?? null),
    effort: effort || capabilities.effort,
    fastMode: typeof snapshot.fastMode === 'boolean' ? snapshot.fastMode : capabilities.fastMode,
    permissions:
      typeof snapshot.permissionMode === 'string'
        ? botPermissionsForSessionMode(snapshot.permissionMode)
        : capabilities.permissions,
  };
}

/**
 * 合并后的 capabilities;与当前值完全一致时返回 `null`,调用方据此**不发 IPC**。
 *
 * 这一条是必需的:每次 `refreshServerSession` 都会触发一次回写尝试,不做等值
 * 短路会把伙伴 Profile 的版本号一路顶上去(每次都算 profileContentChanged)。
 */
export function mergeBotComposerRuntime(
  capabilities: BotCapabilities,
  snapshot: BotComposerRuntimeSnapshot,
): BotCapabilities | null {
  const patch = botComposerRuntimePatch(capabilities, snapshot);
  const unchanged =
    patch.model === capabilities.model &&
    (patch.providerId ?? null) === (capabilities.providerId ?? null) &&
    patch.effort === capabilities.effort &&
    patch.fastMode === capabilities.fastMode &&
    patch.permissions === capabilities.permissions;
  return unchanged ? null : { ...capabilities, ...patch };
}

/**
 * 回写的等待队列 —— 解决「冷启动后第一次改模型静默丢失」。
 *
 * `updateBotProfile` 需要拿当前 `capabilities` 当基底,而基底来自 renderer 的 bot
 * store。应用刚起来时 store 还没 hydrate 完,那个窗口里用户动了模型或权限,原来的
 * 代码直接 `return` —— 改动丢了,下次 Renew 又跳回旧值,全程没有任何反馈。
 *
 * 现在把这次改动存住,订阅 store,等这个伙伴出现了再补写:
 *
 *   - 同一伙伴的多次改动**浅合并**,后一次覆盖同名字段(先改模型再改权限 = 两项都留);
 *   - 换了伙伴则整份替换,绝不把 A 的选择写到 B 身上;
 *   - 写成功、或发现无需写(等值)之后立刻退订,不留常驻监听;
 *   - `dispose()` 供组件卸载时收尾。
 *
 * 同样放在这个叶子模块里,理由与上面那句一致:调用点在 5k 行的 CCAgentSessionView
 * 里,挂不起来单测。
 */
export interface BotRuntimeMirrorDeps {
  /** 取这个伙伴当前的能力位;store 还没这条记录时返回 null。 */
  getCapabilities: (botId: string) => BotCapabilities | null;
  /** 真正落库。失败只影响「下次 Renew 会回跳」,不该打断正在进行的对话。 */
  write: (botId: string, capabilities: BotCapabilities) => void;
  /** store 变化订阅,返回退订函数。 */
  subscribe: (listener: () => void) => () => void;
}

export interface BotRuntimeMirror {
  mirror: (botId: string, snapshot: BotComposerRuntimeSnapshot) => void;
  dispose: () => void;
}

export function createBotRuntimeMirror(deps: BotRuntimeMirrorDeps): BotRuntimeMirror {
  let pending: { botId: string; snapshot: BotComposerRuntimeSnapshot } | null = null;
  let unsubscribe: (() => void) | null = null;

  const settle = (): void => {
    pending = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  /** 返回 false = 基底还拿不到,这次写不了。等值不写也算处理完毕(返回 true)。 */
  const flush = (botId: string, snapshot: BotComposerRuntimeSnapshot): boolean => {
    const capabilities = deps.getCapabilities(botId);
    if (!capabilities) return false;
    const next = mergeBotComposerRuntime(capabilities, snapshot);
    // 等值时 merge 返回 null,不写,也就不会白顶版本号。
    if (next) deps.write(botId, next);
    return true;
  };

  return {
    mirror(botId, snapshot) {
      const merged =
        pending && pending.botId === botId ? { ...pending.snapshot, ...snapshot } : snapshot;
      if (flush(botId, merged)) {
        settle();
        return;
      }
      pending = { botId, snapshot: merged };
      if (unsubscribe) return;
      unsubscribe = deps.subscribe(() => {
        const still = pending;
        if (!still) return;
        if (flush(still.botId, still.snapshot)) settle();
      });
    },
    dispose: settle,
  };
}
