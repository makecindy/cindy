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
 *   - 键为小写归一后的 skillName:自定义 installPath 同样按 name 互斥,
 *     大小写敏感卷上的不同大小写名称也保守串行,不凭 OS 猜测卷的大小写语义。
 *   - 文件变更还需 sharedMutationLease 的跨进程锁；本模块只提供本进程的
 *     fail-fast 状态与持有方提示，不能单独保护正式版/dev/isolated 间的切换。
 */

/** 锁持有方标识 —— 对端获取失败时据此生成可理解的错误文案。 */
export type SkillInstallLockOwner =
  | 'market-install'
  | 'market-uninstall'
  | 'learn-apply'
  | 'local-import'
  | 'local-rename';

interface LockHolder {
  owner: SkillInstallLockOwner;
  /** 持有凭据:release 闭包只释放自己那次获取,迟到/重复调用不会误删后来者。 */
  token: symbol;
}

const holders = new Map<string, LockHolder>();

/** Conservatively serialize case variants, including on case-insensitive Windows/macOS volumes. */
export function skillInstallLockKey(skillName: string): string {
  return skillName.toLowerCase();
}

/**
 * 尝试获取 skillName 的安装锁。
 * - 成功 → 返回幂等的 release 函数(必须在 finally 里调用);
 * - 已被持有 → 返回 null,调用方用 getSkillInstallLockOwner 生成错误信息。
 */
export function tryAcquireSkillInstallLock(
  skillName: string,
  owner: SkillInstallLockOwner,
): (() => void) | null {
  const key = skillInstallLockKey(skillName);
  if (holders.has(key)) return null;
  const token = Symbol(skillName);
  holders.set(key, { owner, token });
  return () => {
    const current = holders.get(key);
    if (current && current.token === token) holders.delete(key);
  };
}

/** 当前持有者(未被持有返回 null)。 */
export function getSkillInstallLockOwner(skillName: string): SkillInstallLockOwner | null {
  return holders.get(skillInstallLockKey(skillName))?.owner ?? null;
}
