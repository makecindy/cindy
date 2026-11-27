/**
 * im/shared/openChannelSession.ts
 * ---------------------------------------------------------------------------
 * IM 渠道(个人 IM 与官方 hook)新建任务的公共入口: 经 `openSession` 做与桌面新建
 * 任务同一套模型准入、Git 初始化与账号代次校验(docs/dev-rules/im-turn-flow.md
 * 批次 2)。
 *
 * 只接管「这是一条新任务」的那一刻: 建行本身仍由 commit 回调里各自既有的路径完成
 * —— 个人 IM 是确定性 id 的 upsert 与 `/new` 的轮换事务(写渠道路由列), 官方 hook 是
 * `maker.createSession` 或 `/new` 的只建行。复用 / 接管 / 复活既有任务不经过这里。
 *
 * 准入可能规范化来源 / 推理强度 / Fast(与桌面新建任务同一结果), 回调拿到的是准入后的
 * 路由; 准入拒绝时抛出(文案以「不会自动更换模型或供应商」收尾), 调用方走各自既有的
 * 渠道失败提示, 不静默换模型。
 */

import { imText } from './imText';
import type { Effort, EngineKind, PermissionMode } from '@cindy/maker-core';

import { makerToDbEngineKind } from '../../../shared/agentKindConversion';
import { createLogger } from '../../logger';
import { isImEffortAcceptedByModel } from '../defaultSessionSettings';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { openSession, type SessionOpenBody } from '../../localDb/sessionOpening';

const log = createLogger('im:channel-session');

/** 渠道为新任务选定的路由(准入前)。 */
export interface ChannelSessionRoute {
  agentDeviceId?: string | null;
  /** 'acp' = 插件引擎(按在它上面新建任务的准入，providerId 指出是哪一个)。 */
  agentKind: EngineKind;
  model: string;
  providerId: string | null;
  /** 缺席 = 渠道没有显式指定(准入后的默认值不回写给调用方, 保持渠道原有省略语义)。 */
  effort?: Effort | '';
  /** 缺席同上。 */
  fastMode?: boolean | 'ultrafast';
  permissionMode: PermissionMode;
  workingDir: string;
  workspaceKind?: 'project' | 'dialogue';
  title?: string;
}

/** 准入后的路由: 只回写渠道显式给过的字段。 */
export interface AdmittedChannelRoute {
  model: string;
  providerId: string | null;
  effort?: Effort | '';
  fastMode?: boolean | 'ultrafast';
}

/**
 * 在渠道**开始读取**新任务所需状态(旧任务、默认配置)之前捕获当前账号, 返回复核函数:
 * 账号已变化时抛错。传给 `openChannelSession` 后与 openSession 自己的代次校验一起生效 ——
 * openSession 只能从它被调用的那一刻起守, 之前的读取窗口要靠调用方更早捕获。
 */
export function captureChannelAccount(): () => void {
  const owner = getCurrentDbClientSnapshot();
  return () => {
    if (!owner || getCurrentDbClientSnapshot() !== owner) {
      throw new Error(imText('imBot.text.shared.session.accountChanged'));
    }
  };
}

export async function openChannelSession<T>(
  id: string,
  route: ChannelSessionRoute,
  commit: (admitted: AdmittedChannelRoute, assertCurrent: () => void) => Promise<T>,
  assertAccount?: () => void,
): Promise<T> {
  // 渠道默认档位与最终模型不兼容时不要硬塞给准入: 准入按「本次显式选择」校验, 不兼容就直接
  // 拒绝建会话; 而失败发生在会话存在之前, agent 侧自救工具都要 session_id 够不着(#11976)。
  // 这里是最小公共入口(建会话 / /new 轮换 / hook 续跑都经过它), 所以只在这一处判定。
  //
  // 两类路由不判定:
  //   - 远程路由(有 agentDeviceId): 模型只存在于执行端, 本地目录看不到, 且 openSession 对远程
  //     路由不走本地准入(mapper 会把缺失的 effort 补成 high), 硬判只会把合法档位误降级;
  //   - acp 插件引擎: 能力由插件自己声明, 不在 Maker 的 agent 词表里。
  const localEngine = route.agentKind === 'acp' ? undefined : route.agentKind;
  const effortAccepted = route.effort === undefined
    || route.agentDeviceId !== undefined && route.agentDeviceId !== null
    || localEngine === undefined
    || isImEffortAcceptedByModel(localEngine, route.model, route.effort);
  if (route.effort !== undefined && !effortAccepted) {
    log.warn('channel default effort not accepted by model; dropping it', {
      agentKind: route.agentKind, model: route.model, effort: route.effort,
    });
  }
  const body: SessionOpenBody = {
    ...(route.title ? { title: route.title } : {}),
    agentKind: makerToDbEngineKind(route.agentKind) as SessionOpenBody['agentKind'],
    model: route.model,
    providerId: route.providerId,
    ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
    ...(route.effort !== undefined && effortAccepted ? { effort: route.effort } : {}),
    ...(route.fastMode !== undefined ? { fastMode: route.fastMode } : {}),
    permissionMode: route.permissionMode,
    ...(route.workspaceKind ? { workspaceKind: route.workspaceKind } : {}),
    workingDir: route.workingDir,
  };
  const { value } = await openSession(
    { id, body, ...(assertAccount ? { assertCurrent: assertAccount } : {}) },
    async (row, assertCurrent) =>
      commit(
        {
          model: row.model,
          providerId: row.providerId ?? null,
          ...(route.effort !== undefined ? { effort: row.effort as Effort | '' } : {}),
          ...(route.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
        },
        assertCurrent,
      ),
  );
  return value;
}
