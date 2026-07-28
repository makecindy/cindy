/**
 * 会话权限档切换 —— composer 与权限卡片共用的唯一写入路径。
 *
 * 原本只长在 ChatInput 里,但 pending 交互期间 ChatInput 整个不挂载
 * (CCAgentSessionView 的互斥渲染),权限卡片自带的档位入口也要走同一套语义,
 * 所以把「确认门 + 远程/本地分支 + runtime-first + 回滚」抽到这里单点持有。
 *
 * 调用方只负责 confirm 弹窗的具体文案与失败 toast —— 本模块不碰 i18n / UI。
 */

import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { createLogger } from '@/lib/logger';
import { makerApiForDevice } from '@/lib/makerTransport';
import * as sessionService from '@/lib/sessionService';
import type { PermissionMode } from '@/lib/userPreferences.types';

const log = createLogger('sessionPermissionMode');

/**
 * - `ok`        已生效(runtime + 持久化都成功,或无 sessionId 的纯本地草稿态)
 * - `unchanged` 目标档就是当前档,一次写入都没发生(见下方同档短路)
 * - `cancelled` 用户在 Full access 二次确认里点了取消,或确认期间原请求已失效
 * - `failed`    runtime 或持久化失败,已尽力回滚;调用方负责提示
 */
export type PermissionModeChangeOutcome = 'ok' | 'unchanged' | 'cancelled' | 'failed';

/**
 * runtime 与持久化已知失配的会话。
 *
 * 本机路径是 runtime-first:runtime 写成功、落库失败时会尽力把 runtime 回滚。
 * 但回滚本身也可能失败 —— 那一刻 UI/DB 还显示旧档,活着的 agent 却已经在新档上
 * (切 Full access 时尤其危险:界面写着"询问",agent 实际免询问)。这种状态下必须
 * 允许用户"重选界面上显示的那一档"来强制对账,所以同档短路要对这些会话失效。
 * 一旦有一次写入完整成功,失配即解除。
 */
const desyncedSessions = new Set<string>();

export interface ApplySessionPermissionModeChangeParams {
  /** 无 sessionId = 新建对话草稿,只走 confirm 门,不落 runtime/DB。 */
  sessionId?: string;
  /**
   * device-link 被控端 id;非空 = 远程会话,走隧道。**由调用方显式传入**,本模块不再
   * 自己查 remoteProjectsStore —— relay 瞬时重连时 store 镜像会被 clear(),视图侧
   * 靠 lastRemoteDeviceIdRef 粘滞保留身份继续按远程渲染,若这里重查就会拿到 undefined
   * 而误落本机分支,用远程 sessionId 去调本机 IPC(必失败,还会污染本机会话记录)。
   * 身份来源必须与渲染判定同源。
   */
  deviceId?: string;
  currentMode: PermissionMode;
  nextMode: PermissionMode;
  /** 进入 Full access 时的二次确认;返回 false 即放弃本次切换。 */
  confirmFullAccess: () => Promise<boolean>;
  /**
   * 确认门通过之后、真正写入之前的最后一道校验;返回 false 则放弃(算 `cancelled`)。
   *
   * 用于把这次切换钉在发起它的那条 pending 请求上:Full access 确认框可以一直开着,
   * 期间原请求可能已被别处(灵动岛 / 另一个控制端)解决,agent 又产生了新的 pending。
   * 此时若照旧写入,dismissAllPending 会把用户根本没看过的新请求一并放行。
   */
  assertStillApplicable?: () => boolean;
}

export async function applySessionPermissionModeChange({
  sessionId,
  deviceId,
  currentMode,
  nextMode,
  confirmFullAccess,
  assertStillApplicable,
}: ApplySessionPermissionModeChangeParams): Promise<PermissionModeChangeOutcome> {
  // 同档短路,必须在确认门之前:PermissionSelector 的选项 onClick 无条件回调(点当前
  // 选中项也会进来),而 maker-core 的 setPermissionMode 无论档位变没变都会
  // dismissAllPending —— 不短路的话,用户在权限卡片上点开菜单又点回当前档,手里那条
  // pending 请求就被"顺手"结掉了(放宽→allow,其它→deny),而他自以为什么都没改。
  // composer 上同样受益:少一次无谓的 runtime + DB 写。
  //
  // 例外:runtime 与持久化已知失配的会话不短路 —— 那时"重选显示中的档"正是用户
  // 唯一的对账手段(见 desyncedSessions 顶注)。
  if (currentMode === nextMode && !(sessionId && desyncedSessions.has(sessionId))) {
    return 'unchanged';
  }

  if (requiresFullAccessConfirmation(currentMode, nextMode)) {
    const confirmed = await confirmFullAccess();
    if (!confirmed) return 'cancelled';
  }

  // 确认门可能挂了很久,写入前再确认这次切换仍然属于发起它的那条请求。
  if (assertStillApplicable && !assertStillApplicable()) return 'cancelled';

  if (!sessionId) return 'ok';

  try {
    if (deviceId) {
      // 控制端纯镜像:运行时隧道 setPermissionMode,被控端持久化后广播回流更新分片。
      // 按 deviceId 直连隧道 —— makerApiFor(sessionId) 同样要回查 store 路由,
      // 重连窗口内会退化成本机 API,与上面 deviceId 注释同一个坑。
      try {
        await makerApiForDevice(deviceId).setPermissionMode(sessionId, nextMode);
      } catch (remoteError) {
        // 隧道那端同样是 runtime-first:被控端 dispatch 先跑 IPC handler 再 await
        // persistRemoteSetting,所以落库失败时 agent 可能已经切档,而 DB 与控制端
        // 镜像都停在旧档。控制端没有可靠回滚手段(再发一次隧道调用同样可能失败,
        // 被控端此刻的真实状态也不可知),只能记账,让"重选显示中的那一档"绕过
        // 同档短路去强制对账。
        desyncedSessions.add(sessionId);
        throw remoteError;
      }
    } else {
      // runtime-first:运行时成功后才持久化，避免 UI/DB 先显示已切换而实际 agent 仍是旧档。
      await window.electronAPI.maker.setPermissionMode(sessionId, nextMode);
      try {
        await sessionService.update(sessionId, { permissionMode: nextMode });
      } catch (persistError) {
        // DB 写入失败时尽力恢复运行时，保持用户看到的旧设置与实际行为一致。
        try {
          await window.electronAPI.maker.setPermissionMode(sessionId, currentMode);
        } catch (rollbackError) {
          // 回滚也失败:UI/DB 停在旧档,活着的 agent 却留在新档。记账,让"重选显示中
          // 的那一档"能绕过同档短路去强制对账(见 desyncedSessions 顶注)。
          desyncedSessions.add(sessionId);
          log.warn('permission runtime rollback failed:', rollbackError);
        }
        throw persistError;
      }
    }
    // 一次完整成功的写入即代表 runtime 与持久化重新对上。
    desyncedSessions.delete(sessionId);
    return 'ok';
  } catch (err) {
    log.warn('permission change failed:', err);
    return 'failed';
  }
}
