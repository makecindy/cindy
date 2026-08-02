/**
 * installLock.ts —— skill 安装目录 final-switch 的进程内共享互斥。
 *
 * 背景:市场安装(skillhub/installService)与 learn 落盘(learn-host/apply,由
 * learn-host/controller 调用)都会对 `~/.agents/skills/<name>/` 做 final switch
 * (rename 旧目录到备份 → 切入新目录 → 写 registry)。两条路径此前各自持锁
 * (installService 的 inflight Map / controller 的 skillApplyLocks Set),互不
 * 感知 —— 同名并发时双方会 rename 同一 finalDir、registry 写入交错。本模块把
 * 互斥收敛到单一进程级注册表,两边共用,按 skillName 串行化(规则 9:用代码
 * 保证确定性)。
 *
 * 语义:
 *   - try-lock(fail-fast):已被持有时再次获取直接失败,不排队 —— 与两侧既有
 *     语义一致(市场侧返回"正在安装中"错误,learn 侧抛 LEARN_BUSY)。
 *   - 键为 skillName(与 installService 原 inflight Map 的键一致):自定义
 *     installPath 的市场安装同样按 name 互斥,宁可保守多拦。
 *   - 进程内即可:市场安装与 learn 落盘都跑在 desktop main 进程。
 */

/** 锁持有方标识 —— 对端获取失败时据此生成可理解的错误文案。 */
export type SkillInstallLockOwner =
  | 'market-install'
  | 'market-uninstall'
  | 'learn-apply'
  | 'local-import';

interface LockHolder {
  owner: SkillInstallLockOwner;
  /** 持有凭据:release 闭包只释放自己那次获取,迟到/重复调用不会误删后来者。 */
  token: symbol;
}

const holders = new Map<string, LockHolder>();

/**
 * 尝试获取 skillName 的安装锁。
 * - 成功 → 返回幂等的 release 函数(必须在 finally 里调用);
 * - 已被持有 → 返回 null,调用方用 getSkillInstallLockOwner 生成错误信息。
 */
export function tryAcquireSkillInstallLock(
  skillName: string,
  owner: SkillInstallLockOwner,
): (() => void) | null {
  if (holders.has(skillName)) return null;
  const token = Symbol(skillName);
  holders.set(skillName, { owner, token });
  return () => {
    const current = holders.get(skillName);
    if (current && current.token === token) holders.delete(skillName);
  };
}

/** 当前持有者(未被持有返回 null)。 */
export function getSkillInstallLockOwner(skillName: string): SkillInstallLockOwner | null {
  return holders.get(skillName)?.owner ?? null;
}
