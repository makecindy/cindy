/**
 * Cindy 记忆(普通任务用的那一套)「查看记忆」页的跨进程线型(main / preload / renderer 共用)。
 *
 * 一条记忆的列表项、详情与「打开之后被改过」的拒绝原因,与伙伴记忆页是同一份
 * (`shared/botMemory.ts`): 两个页面共用同一个列表 / 详情 / 编辑组件和同一套读写规则,
 * 区别只在记忆属于哪里 —— 伙伴按 botId, 这里按记忆范围 (scope)。
 *
 * 范围有两种: 账号级(关于用户本人, 每个项目都生效)与项目级(一个仓库根或文件夹一份)。
 * `scopeKey` 由 main 的 `MakerMemoryManager.listScopes()` 给出, renderer 只能原样带回;
 * main 每次都对照该列表校验, 不为任意传入的路径打开存储。
 */

export interface MakerMemoryScopeSummary {
  /** 读 / 改 / 删时原样带回的范围标识。 */
  scopeKey: string;
  kind: 'user' | 'project';
  /** 这一份里的记忆条数(不含内部 digest)。 */
  count: number;
  /** 项目范围: 文件夹名。账号级没有。 */
  name?: string;
  /** 项目范围: 仓库根或文件夹的绝对路径; SSH 项目是远程主机上的路径。 */
  path?: string;
  /** SSH 项目: 路径所在的远程主机。 */
  host?: string;
}

export interface MakerMemoryEntryUpdateInput {
  scopeKey: string;
  filename: string;
  title: string;
  body: string;
  /** 打开编辑时看到的 updatedAt; 不一致说明任务刚改过这条, 拒绝覆盖。 */
  expectedUpdatedAt: string;
}

export interface MakerMemoryEntryDeleteInput {
  scopeKey: string;
  filename: string;
  expectedUpdatedAt: string;
}

/** `scopes` 的可选入参: 一个任务的工作目录, 用来在范围列表里指出它的项目是哪一份。 */
export interface MakerMemoryTaskLocation {
  workingDir: string;
  /** SSH 任务: 工作目录所在的远程主机。 */
  remoteHostId?: string | null;
}

export interface MakerMemoryScopesResult {
  scopes: MakerMemoryScopeSummary[];
  /**
   * 传了任务位置时: 该任务的项目记忆在列表里的 scopeKey; 不在列表里(还没有记忆、
   * 一次性对话、没传位置)为 null, 页面落在「关于你」。
   */
  taskScopeKey: string | null;
}
