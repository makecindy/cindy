/**
 * overlaySlot.ts — 桌面浮窗(overlay)请求槽的守门(2026-10-15)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'overlay-request', kind, ...payload}`,请主机代管它的
 * 透明置顶浮窗。与 pickSlot 同一哲学:纯逻辑 + 依赖注入(规则 14),Electron
 * `screen` 与 Task 4 的 GhostOverlayWindowsController 在组装时注入。
 *
 * 安全模型(fail closed):
 * - `mount`:未声明 overlay → OVERLAY_NOT_DECLARED;用户开关关闭 →
 *   OVERLAY_USER_DISABLED;二者都过才 prewarm + show。
 * - kind 白名单:未知 kind 恒 INVALID_PARAMS,与是否 mount 无关。
 * - `move`:x/y 必须是有限整数(非有限数 → INVALID_PARAMS);越出全部显示器
 *   bounds 的联合边界时钳制到最近边界(不报错)。只钳坐标、不扣窗口尺寸:
 *   窗口右/下缘仍可能有超出联合边界的像素(整窗宽高不参与计算),属预期。
 * - `set-interactive`:interactive 必须是布尔(否则 INVALID_PARAMS)。
 * - 其余有状态 kind(unmount/show/hide/move/set-interactive/cursor-*)在
 *   "kind 合法且参数合法"但未 mount 时 → OVERLAY_NOT_MOUNTED。
 * - `displays`:只读查询,返回全部显示器的 { id, bounds, workArea, scaleFactor };
 *   不要求 mount,但必须在声明之内(fail closed)。
 * - `cursor-subscribe/unsubscribe`:本槽只定义转发接口(注入 deps),光标流本体
 *   在 Task 6、接线在 Task 7,这里不实现流。
 *
 * 结果与 pick 同构:结构化 { ok, errorCode, message };handle 顶层 try/catch
 * 把意外 reject 兜成 INTERNAL,永不 reject。
 */

export type GhostOverlaySlotKind =
  | 'mount'
  | 'unmount'
  | 'show'
  | 'hide'
  | 'move'
  | 'set-interactive'
  | 'displays'
  | 'cursor-subscribe'
  | 'cursor-unsubscribe';

export type GhostOverlayErrorCode =
  | 'OVERLAY_NOT_DECLARED'
  | 'OVERLAY_USER_DISABLED'
  | 'OVERLAY_NOT_MOUNTED'
  | 'INVALID_PARAMS'
  | 'INTERNAL';

/** kind 白名单:运行期校验的唯一正本(对外仍以运行期为准,不依赖 TS 类型)。 */
export const GHOST_OVERLAY_SLOT_KINDS: readonly GhostOverlaySlotKind[] = [
  'mount',
  'unmount',
  'show',
  'hide',
  'move',
  'set-interactive',
  'displays',
  'cursor-subscribe',
  'cursor-unsubscribe',
];

export function isGhostOverlaySlotKind(kind: string): kind is GhostOverlaySlotKind {
  return (GHOST_OVERLAY_SLOT_KINDS as readonly string[]).includes(kind);
}

/** 显示器精简视图:displays 查询与 move 钳制共用,与 Electron Display 同形。 */
export interface GhostOverlayDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface GhostOverlaySlotDeps {
  /** 该意识是否声明了 overlay 槽(Task 2 GhostOverlayDecl)。 */
  isGhostOverlayDeclared(ghostId: string): boolean;
  /** 用户级 kill switch(Task 8);false = 拒 mount。 */
  isUserEnabled(ghostId: string): boolean;
  /** 浮窗是否已挂载(controller.getState()[ghostId]?.mounted === true)。 */
  isMounted(ghostId: string): boolean;
  /** Task 4 controller 生命周期直通。 */
  prewarm(ghostId: string): void;
  show(ghostId: string): Promise<void>;
  hide(ghostId: string): void;
  move(ghostId: string, x: number, y: number): void;
  setInteractive(ghostId: string, interactive: boolean): void;
  unmount(ghostId: string): void;
  /** 全部显示器(move 钳制用 bounds;displays 查询直接透出)。 */
  getAllDisplays(): GhostOverlayDisplay[];
  /** 光标流转发接口(Task 6 实现、Task 7 接线),本槽不实现流。 */
  subscribeCursor(ghostId: string): void;
  unsubscribeCursor(ghostId: string): void;
}

export type GhostOverlaySlotResult =
  | { ok: true; displays?: GhostOverlayDisplay[] }
  | { ok: false; errorCode: GhostOverlayErrorCode; message: string };

export interface GhostOverlaySlot {
  handle(ghostId: string, kind: string, payload: unknown): Promise<GhostOverlaySlotResult>;
}

function fail(
  errorCode: GhostOverlayErrorCode,
  message: string,
): Extract<GhostOverlaySlotResult, { ok: false }> {
  return { ok: false, errorCode, message };
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * 把坐标钳制进全部显示器 bounds 的联合边界(无显示器时不钳制)。
 * 只钳窗口左上角坐标、不扣窗口尺寸:右/下缘可能仍超出联合边界,属预期。
 */
function clampToDisplayBounds(
  x: number,
  y: number,
  displays: GhostOverlayDisplay[],
): { x: number; y: number } {
  if (displays.length === 0) return { x, y };
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

/** 桌面浮窗请求槽:资格审 → 校验(先 kind/参数,后 mount)→ 直通/查询/转发。 */
export function createGhostOverlaySlot(deps: GhostOverlaySlotDeps): GhostOverlaySlot {
  return {
    async handle(ghostId, kind, payload): Promise<GhostOverlaySlotResult> {
      try {
        // displays 是只读查询:不要求 mount(惰性查询合理),但必须声明 overlay
        // 之后才可查(fail closed,与其它 kind 对齐)。
        if (kind === 'displays') {
          if (!deps.isGhostOverlayDeclared(ghostId)) {
            return fail('OVERLAY_NOT_DECLARED', '插件未声明 overlay 槽');
          }
          return { ok: true, displays: deps.getAllDisplays() };
        }

        if (kind === 'mount') {
          if (!deps.isGhostOverlayDeclared(ghostId)) {
            return fail('OVERLAY_NOT_DECLARED', '插件未声明 overlay 槽');
          }
          if (!deps.isUserEnabled(ghostId)) {
            return fail('OVERLAY_USER_DISABLED', '用户已关闭 overlay');
          }
          deps.prewarm(ghostId);
          await deps.show(ghostId);
          return { ok: true };
        }

        // kind 白名单:未知 kind 恒 INVALID_PARAMS,与是否 mount 无关。
        if (!isGhostOverlaySlotKind(kind)) {
          return fail('INVALID_PARAMS', `未知的 overlay kind:${kind}`);
        }

        // move / set-interactive 的参数校验先于 mount 判定:非法参数与未 mount
        // 是两个独立错误码,不能互相吞并。
        if (kind === 'move') {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return fail('INVALID_PARAMS', 'move 载荷必须是 { x, y } 对象');
          }
          const { x, y } = payload as { x?: unknown; y?: unknown };
          if (!isFiniteInteger(x) || !isFiniteInteger(y)) {
            return fail('INVALID_PARAMS', 'x/y 必须是有限整数');
          }
          if (!deps.isMounted(ghostId)) {
            return fail('OVERLAY_NOT_MOUNTED', '浮窗尚未挂载,请先 mount');
          }
          const clamped = clampToDisplayBounds(x, y, deps.getAllDisplays());
          deps.move(ghostId, clamped.x, clamped.y);
          return { ok: true };
        }

        if (kind === 'set-interactive') {
          const interactive = (payload as { interactive?: unknown } | null)?.interactive;
          if (typeof interactive !== 'boolean') {
            return fail('INVALID_PARAMS', 'interactive 必须是布尔值');
          }
          if (!deps.isMounted(ghostId)) {
            return fail('OVERLAY_NOT_MOUNTED', '浮窗尚未挂载,请先 mount');
          }
          deps.setInteractive(ghostId, interactive);
          return { ok: true };
        }

        // 其余有状态 kind(unmount/show/hide/cursor-*):kind 合法、无参数校验,
        // 未 mount 一律 fail closed。
        if (!deps.isMounted(ghostId)) {
          return fail('OVERLAY_NOT_MOUNTED', '浮窗尚未挂载,请先 mount');
        }

        switch (kind) {
          case 'unmount':
            deps.unmount(ghostId);
            return { ok: true };
          case 'show':
            await deps.show(ghostId);
            return { ok: true };
          case 'hide':
            deps.hide(ghostId);
            return { ok: true };
          case 'cursor-subscribe':
            deps.subscribeCursor(ghostId);
            return { ok: true };
          case 'cursor-unsubscribe':
            deps.unsubscribeCursor(ghostId);
            return { ok: true };
          default:
            // kind 已过白名单,运行时不可达;仅为穷举兜底。
            return fail('INVALID_PARAMS', `未知的 overlay kind:${kind}`);
        }
      } catch (error) {
        // 意外异常兜成中性文案(其它槽同款):不向插件透传原始 error.message,
        // 也不调用 String(error)(无原型对象可能再抛)。本槽无 log 依赖,不记录。
        void error;
        return fail('INTERNAL', 'overlay 请求处理失败');
      }
    },
  };
}
