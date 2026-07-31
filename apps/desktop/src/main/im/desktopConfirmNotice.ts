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
 * 组装 fire-and-forget 通知函数(DI 便于单测;生产接线见
 * desktopConfirmNoticeWiring.ts)。
 */
export function createDesktopConfirmNotifier(
  deps: DesktopConfirmNoticeDeps,
): (sessionId: string, what: string) => void {
  return (sessionId, what) => {
    void (async () => {
      try {
        const openId = await deps.getFeishuOpenId(sessionId);
        if (!openId) return;
        await deps.sendFeishuText(openId, buildDesktopConfirmNoticeText(what));
      } catch (err) {
        deps.logWarn?.(
          `desktop-confirm IM notice failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };
}
