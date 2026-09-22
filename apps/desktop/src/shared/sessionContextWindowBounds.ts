/**
 * 任务窗口档位表的**权威边界** —— main 与 renderer 的共享契约。
 *
 * 事实来源：main 侧 `resolveSessionContextWindowBounds`（与运行期
 * `resolveConfiguredContextWindow` 同一套口径：目录路由唯一候选 + 该路由的模型级上限
 * + 隐式来源解析）。renderer 自己解析跨 provider 同 id 的模型时解不出来源，会给出
 * main 一定会夹掉的档位 —— 档位表必须读这份，本地经 `maker:get-context-window-bounds`
 * handler，远程经 device-link 的同名 channel（被控端算）。
 *
 * 三个窗口值都可能为 null：null = **未知**（不是无限），调用方必须退回「只允许收紧」。
 */
import type { MakerAgentKindWire } from './agentKindConversion.js';

export interface SessionContextWindowBounds {
  /** 实际解析到的来源 providerId；供调用方读同一路由的模型级上限/报价。 */
  providerId: string | null;
  /** 该路由的默认工作窗口（`min(contextWindow, contextWindowMax)`）。 */
  defaultWindow: number | null;
  /** 该路由声明的物理上限（`contextWindowMax`）。 */
  maxWindow: number | null;
  /** 用户在同一路由上设过的模型级「上下文上限」。 */
  modelLimit: number | null;
  /**
   * 该任务已保存的预算（用户显式设过的**原始**值，tokens）；null = 跟随默认。
   *
   * 与上面三个字段同源（同一个 handler / 同一条隧道）：档位表既要画可选档位，也要标出
   * 当前选中的那一档。预算是 main 侧偏好文件里的条目，不是会话列，所以随边界一起回来，
   * 不依赖调用方手里的会话快照（远程会话拿不到被控端的库）。
   */
  budget: number | null;
  /** 用户是否显式设过（区分「跟随默认」与「设了一个刚好等于默认的值」）。 */
  budgetCustomized: boolean;
  /**
   * **清掉任务预算后**「跟随默认」会得到的窗口（= main 的 `resolveConfiguredContextWindow`，
   * 传 `sessionBudget = null`：模型级上限再按已核实路由的物理上限 `contextWindowMax ?? contextWindow`
   * 夹一次）。它是档位表里「模型默认」那一档的真实含义 —— 选中它会上报 `null`，运行期回到这个值。
   *
   * 刻意不带当前任务预算：把「当前生效窗口」当成默认档会让菜单显示 500K、点下去却变成 800K
   * （任务预算被清除）。调用方也不要自己用 defaultWindow/modelLimit 重推：那套推导已经在
   * `resolveVerifiedContextWindow` / `declaredMax` 里做过一次，重推必与运行期分叉。
   */
  defaultEffectiveWindow: number | null;
  /**
   * main 实际会施加的**物理上限**（= `resolveVerifiedContextWindow` 里的
   * `contextWindowMax ?? contextWindow`，仅当路由唯一且 `contextWindowVerified === true` 时有值；
   * 未核实路由没有这道夹，返回 null）。
   *
   * 档位基准不能只看目录声明的 `maxWindow`：已核实但**未声明** `contextWindowMax` 的路由，
   * 运行期照样被 `contextWindow` 夹住；renderer 不知道 `contextWindowVerified`，所以这个值由
   * main 算好下发，避免档位表给出运行期根本达不到的档。
   */
  maxEffectiveWindow: number | null;
}

/** 被控端/主进程返回值的形状收敛：缺字段或非法值一律按「未知」处理（不猜上限）。 */
export function normalizeSessionContextWindowBounds(
  value: unknown,
): SessionContextWindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const positive = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  const defaultWindow = positive(raw.defaultWindow);
  const maxWindow = positive(raw.maxWindow);
  if (defaultWindow === null && maxWindow === null) return null;
  return {
    providerId: typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null,
    defaultWindow,
    maxWindow,
    modelLimit: positive(raw.modelLimit),
    budget: positive(raw.budget),
    budgetCustomized: raw.budgetCustomized === true,
    defaultEffectiveWindow: positive(raw.defaultEffectiveWindow),
    maxEffectiveWindow: positive(raw.maxEffectiveWindow),
  };
}

/** 查询参数里允许携带的引擎标识（与 `maker-ipc` 的 `AgentKind` 同值域）。 */
export function isSessionContextWindowAgentKind(
  value: unknown,
): value is MakerAgentKindWire {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
}

/**
 * 边界查询的**路由**：界面上正在显示的那条路由。
 *
 * 为什么需要它：同名会话在「延迟切换」期间，模型选择器已经指向目标模型，而 DB 行仍是旧
 * 路由（切模在发送边界才落库）。此时只按会话 id 查边界，被控端会按**旧行**回答，档位表与
 * chip 显示值一起停在旧模型上（旧窗口 262K 切到 1M 模型后仍显示 262K，用户已实测报障）。
 * 带上显示路由后，档位表始终按「用户看到的那条路由」算，与写入路径的目标路由一致。
 */
export interface SessionContextWindowBoundsRoute {
  /** maker-core 引擎标识；与 `model` 一起构成路由，两者缺一即视为未携带。 */
  agent?: MakerAgentKindWire | null;
  /** 目标模型的显式来源；null = 未显式指定（由目录隐式解析，与运行期同口径）。 */
  providerId?: string | null;
  model?: string | null;
}

/** 单个路由字段的长度上限：正常 id 远小于它，超长一律视为畸形输入。 */
const MAX_ROUTE_FIELD_LENGTH = 256;

/**
 * 收敛调用方携带的路由（renderer 或 device-link 远程控制端都可能传任意值）。
 *
 * 返回 null = **未携带可用路由**（调用方必须退回「按会话行回答」），而不是「按空路由回答」：
 * 任意字段类型不对就整份拒绝，绝不用调用方给的一半路由去解析另一条来源。
 */
export function normalizeSessionContextWindowBoundsRoute(
  value: unknown,
): SessionContextWindowBoundsRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (input: unknown): string | null | undefined => {
    if (input === undefined || input === null) return null;
    if (typeof input !== 'string') return undefined;
    const trimmed = input.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_ROUTE_FIELD_LENGTH ? undefined : trimmed;
  };
  const agent = text(raw.agent);
  const providerId = text(raw.providerId);
  const model = text(raw.model);
  if (agent === undefined || providerId === undefined || model === undefined) return null;
  // 只有「引擎 + 模型」都在时才构成路由；只给 provider 无法解析窗口。
  if (!isSessionContextWindowAgentKind(agent) || !model) return null;
  return { agent, providerId, model };
}
