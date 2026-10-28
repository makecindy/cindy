/**
 * im/desktopConfirmNotice.ts — 桌面专属确认卡挂起时的 IM 侧提示(#926)。
 *
 * issue_confirm / rename confirm / ghost_grant_confirm 这类确认卡**有意**只在
 * 桌面端出现(见 issueConfirmBridge 头注:它们不进 agent 的 InteractionRequest
 * union,feishu /ctr 接管路径对未知 kind 会直接 deny)。但飞书驱动的会话里用户
 * 人在 IM 侧,看不到卡片,只能等到 CONFIRM_TIMEOUT 才知道出了事。
 *
 * 这里补的是**不可交互的文字提示**:卡片仍然只在桌面(不动既有设计边界),
 * IM 侧即时收到「有确认卡在桌面等你」。best-effort:提示失败绝不影响确认流程
 * (fire-and-forget,桥不等待、不感知失败)。
 *
 * 本文件只放纯逻辑(零 electron / db 依赖,单测直接引);生产接线在
 * desktopConfirmNoticeWiring.ts(按 architecture-invariants §2 顶层静态 import)。
 */

export interface DesktopConfirmNoticeDeps {
  /** 会话绑定的飞书 openId;非飞书会话返回 null(桌面本来就是唯一交互面)。 */
  getFeishuOpenId(sessionId: string): Promise<string | null>;
  sendFeishuText(openId: string, markdown: string): Promise<unknown>;
  /**
   * 该任务开了「消息免打扰」→ IM 侧提示也不发,与 toast / 灵动岛 / 手机推送
   * 同一口径。桌面卡片本身不受影响:提示是提醒,卡片是交互面。
   */
  isSuppressed?(sessionId: string): boolean;
  logWarn?(message: string): void;
}

/** 飞书目标解析的注入面(纯逻辑可单测;生产接线见 desktopConfirmNoticeWiring.ts)。 */
export interface FeishuNoticeTargetDeps {
  /** bindingStore.findByTarget:/ctr 接管的普通会话,接管者身份在 binding 而非 session 行。 */
  findBinding(sessionId: string): { channel: string; userId: string } | null;
  /** sessions 行的 feishuOpenId(飞书原生会话)。 */
  getSessionOpenId(sessionId: string): Promise<string | null>;
}

/**
 * 解析确认提示应发往的飞书 openId。优先接管绑定(review P1:/ctr 接管的普通
 * desktop 会话,session 行的 feishuOpenId 为 null,接管者身份保存在 bindingStore),
 * 其次才是飞书原生会话的 session 行;两者皆无 → null(非飞书场景,零动作)。
 */
export async function resolveFeishuNoticeTarget(
  deps: FeishuNoticeTargetDeps,
  sessionId: string,
): Promise<string | null> {
  const bound = deps.findBinding(sessionId);
  if (bound?.channel === 'feishu' && bound.userId) return bound.userId;
  return deps.getSessionOpenId(sessionId);
}

/** 提示文案(纯函数,便于单测锚定)。 */
export function buildDesktopConfirmNoticeText(what: string): string {
  return `🔔 ${what}正在桌面端 Cindy 等待你的确认;超时将自动取消,如需继续请到桌面端操作。`;
}

/**
 * 代输入提示:只给任务名与入口,不含界面内容,也不接收输入(值只走签名加密通道)。
 * 任务名是原样数据,模板只做拼接。
 */
export function buildInputHandoffNoticeText(taskTitle: string): string {
  return `🔐 需要你帮忙输入:${taskTitle} · 在 Cindy 中打开`;
}

/**
 * 组装 fire-and-forget 通知函数(DI 便于单测;生产接线见
 * desktopConfirmNoticeWiring.ts)。
 */
export function createDesktopConfirmNotifier(
  deps: DesktopConfirmNoticeDeps,
  buildText: (what: string) => string = buildDesktopConfirmNoticeText,
): (sessionId: string, what: string) => void {
  return (sessionId, what) => {
    if (deps.isSuppressed?.(sessionId)) return;
    void (async () => {
      try {
        const openId = await deps.getFeishuOpenId(sessionId);
        if (!openId) return;
        // 解析 openId 要查库,期间用户可能刚开了免打扰:真正发之前再确认一次
        // (与 notificationService 在异步富化后、发送前的那道判定同口径)。
        if (deps.isSuppressed?.(sessionId)) return;
        await deps.sendFeishuText(openId, buildText(what));
      } catch (err) {
        deps.logWarn?.(
          `desktop-confirm IM notice failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };
}
