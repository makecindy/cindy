/**
 * 跨任务的「程序开栏」标记。
 *
 * 插件 / agent / MCP App 在后台任务上把右栏放出来时，那次开栏只落档、不占窗口宽度；
 * 用户第一次进到那个任务时，记忆恢复出来的展开仍要按被动展示处理，否则一次自动化
 * 开栏会让普通落地把窗口拉宽（规则见 PR：只有用户亲手开/关右栏才改窗口矩形）。
 *
 * 标记按任务记账、只对第一次声明有效：落地到目标任务时消费掉，别处落地不会把它吃掉。
 * 只活在当前进程里——重启之后那格记忆与「用户自己开着」不可区分，按启动恢复的既有
 * 口径展开，不再假装是程序动作。
 */
export interface PassiveRevealMarker {
  mark(targetSessionId: string): void;
  /** 落地到目标任务时消费并清空；别的任务声明时返回 false 并保留标记。 */
  consume(committedSessionId: string | null): boolean;
  /** 目标任务被程序收起：本次开栏不再成立。 */
  drop(targetSessionId: string): void;
  clear(): void;
}

/** 只留最近若干个：自动化开栏可能远多于用户真正去过的任务。 */
const LIMIT = 32;

export function createPassiveRevealMarker(): PassiveRevealMarker {
  const targets = new Set<string>();
  return {
    mark(targetSessionId: string): void {
      targets.delete(targetSessionId);
      targets.add(targetSessionId);
      while (targets.size > LIMIT) {
        const oldest = targets.values().next().value;
        if (oldest === undefined) break;
        targets.delete(oldest);
      }
    },
    consume(committedSessionId: string | null): boolean {
      if (!committedSessionId || !targets.has(committedSessionId)) return false;
      targets.delete(committedSessionId);
      return true;
    },
    drop(targetSessionId: string): void {
      targets.delete(targetSessionId);
    },
    clear(): void {
      targets.clear();
    },
  };
}
