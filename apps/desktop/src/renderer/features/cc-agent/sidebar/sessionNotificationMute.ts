import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';

const log = createLogger('session-notification-mute');

/**
 * 同一个任务可能有多条静音写入同时在飞（连点、主窗与副窗、两个窗口）。回滚只属于
 * 「最后一次发起、且期间没人再改过」的那一次；只比布尔值分不出同向并发。
 */
const latestWriteSeq = new Map<string, number>();
let writeSeq = 0;

/**
 * 任务级「消息免打扰」开关（会话右键菜单）。
 *
 * 开了之后这个任务不再产生外向提醒：不发系统通知（toast / 提示音）、不上 Agent
 * 灵动岛、不推手机、不发 IM 消息；任务内的未读与角标照常，任务本身照常跑。
 *
 * 乐观更新 + 失败回滚与置顶同款：先 patchLocal 让侧栏立刻切过去，写库失败再翻回来
 * 并抛出，由调用方决定怎么提示。失败必须回滚——留着一个没落库的「已静音」会让用户
 * 以为不会被打扰，实际照旧；但回滚本身不能盖掉期间别处刚写进来的新值。
 */
export async function setSessionNotificationsMuted(session: Session, muted: boolean): Promise<void> {
  const previous = session.notificationsMuted === true;
  const seq = ++writeSeq;
  latestWriteSeq.set(session.id, seq);
  sessionsStore.patchLocal(session.id, { notificationsMuted: muted });
  try {
    await sessionService.patchMeta(session.id, { notificationsMuted: muted });
  } catch (error) {
    // 两个条件都要：
    // - 自己仍是这个任务最后一次发起的写入（挡同向并发：两个窗口都在关静音，先失败的
    //   那次不能把后一次的成功翻回去）；
    // - 值还是自己写进去的那个（挡期间别处广播来的新值）。
    if (
      latestWriteSeq.get(session.id) === seq &&
      sessionsStore.findById(session.id)?.notificationsMuted === muted
    ) {
      sessionsStore.patchLocal(session.id, { notificationsMuted: previous });
    }
    log.error('[session notification mute]', error);
    throw error;
  }
}
