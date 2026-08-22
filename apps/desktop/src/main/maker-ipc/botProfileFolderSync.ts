/**
 * 文件 → 冻结快照的对账。
 *
 * `botProfileFolder.ts` 让伙伴的档案摊成了文件,但光能写还不够:**用户拿编辑器
 * 改完 SOUL.md、或者伙伴自己用文件工具改完自己的灵魂之后,得有人把这件事收进去**,
 * 否则文件就只是一份写出去没人看的副本 —— 那还不如没有。
 *
 * 这一层就是那个「收进去」的动作:
 *
 *   - 家还没建 → 用数据库里的当前值播种(存量伙伴第一次遇到新版本时走这条);
 *   - 文件与冻结快照不一致 → 按文件派生一个新版本;
 *   - 一致 → 什么都不做。
 *
 * 派生而不是就地改,是因为运行中的任务认的是版本号:派生出新版本之后,**进行中的
 * 对话仍然跑在旧版本上,下一轮才换过去** —— 契约 9.3 节的「等待下一轮生效」。
 * 就地改会让一个跑到一半的任务中途换身份。
 *
 * 何时对账:应用启动时对所有伙伴跑一遍,以及每次要开新任务之前跑一次。两处都
 * 便宜(没改过就是几次读文件),而漏掉任何一处的后果都是「我明明改了文件却没生效」。
 *
 * 纯逻辑 + 注入,不 import Electron 与数据库 —— 判定要能直接单测。
 */

import type { BotProfileFolderContent, BotProfileFolderSeed } from './botProfileFolder.js';

/** 数据库里那份冻结快照(当前版本行)。 */
export interface BotProfileSnapshot {
  identitySource: string;
  /** `capabilities_json` 解出来的对象,含 `userContextSource`。 */
  config: Record<string, unknown>;
  currentVersion: number;
}

export interface BotProfileFolderSyncDeps {
  readSnapshot: (botId: string) => Promise<BotProfileSnapshot | null>;
  readFolder: (botId: string) => Promise<BotProfileFolderContent>;
  /** 家还没建时用快照播种(内部会顺带搬技能)。 */
  seedFolder: (botId: string, seed: BotProfileFolderSeed) => Promise<void>;
  /** 按文件内容派生一个新版本。实现方走与设置页保存**同一条**事务。 */
  deriveVersion: (input: {
    botId: string;
    identitySource: string;
    config: Record<string, unknown>;
    expectedCurrentVersion: number;
  }) => Promise<void>;
}

export type BotProfileFolderSyncOutcome =
  /** 数据库里没有这个伙伴。 */
  | 'missing'
  /** 家还没建,已按数据库播种。 */
  | 'seeded'
  /** 文件比快照新,已派生新版本(下一轮生效)。 */
  | 'derived'
  /** 文件与快照一致。 */
  | 'unchanged';

/**
 * 文件内容与快照是不是同一份。
 *
 * `userContextSource` 在数据库里躺在 `config` 里,在磁盘上是独立的
 * `memories/USER.md` —— 比对时要把两边拉回同一个形状,否则每次对账都会判成
 * 「变了」,无限派生新版本。
 */
export function botProfileFolderMatchesSnapshot(
  folder: BotProfileFolderContent,
  snapshot: BotProfileSnapshot,
): boolean {
  if (folder.identitySource !== snapshot.identitySource) return false;
  const { userContextSource: snapshotUserContext, ...snapshotRest } = snapshot.config;
  const expectedUserContext =
    typeof snapshotUserContext === 'string' ? snapshotUserContext : '';
  if (folder.userContextSource !== expectedUserContext) return false;
  return JSON.stringify(sortKeys(folder.config)) === JSON.stringify(sortKeys(snapshotRest));
}

/** 键顺序不该算差异 —— 用户手改 JSON 时很容易换顺序。 */
function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

export async function syncBotProfileFromFolder(
  botId: string,
  deps: BotProfileFolderSyncDeps,
): Promise<BotProfileFolderSyncOutcome> {
  const snapshot = await deps.readSnapshot(botId);
  if (!snapshot) return 'missing';

  const folder = await deps.readFolder(botId);
  // 没有 SOUL.md = 家还没建起来(存量伙伴,或者用户把它删了)。用数据库那份播种,
  // 而不是把伙伴的身份当成"被清空了" —— 删掉一个文件不该等于抹掉一个人格。
  if (!folder.identitySource.trim()) {
    await deps.seedFolder(botId, {
      identitySource: snapshot.identitySource,
      userContextSource:
        typeof snapshot.config.userContextSource === 'string'
          ? snapshot.config.userContextSource
          : '',
      config: stripUserContext(snapshot.config),
    });
    return 'seeded';
  }

  if (botProfileFolderMatchesSnapshot(folder, snapshot)) return 'unchanged';

  await deps.deriveVersion({
    botId,
    identitySource: folder.identitySource,
    // 写回数据库时再把用户画像塞回 config —— 那是数据库这边的形状。
    config: { ...folder.config, userContextSource: folder.userContextSource },
    expectedCurrentVersion: snapshot.currentVersion,
  });
  return 'derived';
}

function stripUserContext(config: Record<string, unknown>): Record<string, unknown> {
  const { userContextSource: _ignored, ...rest } = config;
  return rest;
}
