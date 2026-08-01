/**
 * 「我的 Issue」首屏快照的落盘存储。
 *
 * 为什么需要它:列表要等平台通道与 GitHub 增强都落地才出现(增强走插件失败 + gh CLI
 * 回退时实测约 2s),而 service 那层的 60s TTL 缓存是**内存**的 —— 进程一重启就没了,
 * 首次进页面必然 miss。于是每次冷启动进 /issues 都要空等几秒。存一份上次的结果,
 * 进页面立刻有内容可读。
 *
 * 语义边界(与 device-link/mirrorCacheStore 同构,那套注释直接适用):
 *  - 快照是**可重建的首屏镜像,不是真相**。远端仍是唯一真相源,fresh 一到即整体接管。
 *  - **不缓存「这一次查得怎么样」**(degraded / enhancementFailed / truncated):
 *    那是本次查询的健康状况,缓存它等于让用户进页面就看到一条过期的错误提示。
 *  - 快照里的空列表**不构成**「查证过的空」,不能推出「你从未提交」(见 MyIssuesSnapshot)。
 *
 * 为什么用 electron-store 而不照搬 mirrorCacheStore 的那套 IO:后者的 purge 队列、
 * 跨进程锁、作废屏障是为多设备消息文件与内联媒体设计的;这里只是「一个数组 + 上限 +
 * 校验」,与同目录的 submittedIssueLedger 同构,照它的形状写就够。
 *
 * 存储位置走 ownerScopedUserDataPath():按 Cindy 账号天然隔离,换号 / 登出后读不到
 * 旧账号的 issue 标题与 GitHub 用户名(这是账号私有数据,不是可共享的缓存)。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import Store from 'electron-store';

import type { MyIssueItem, MyIssueSource, MyIssuesSnapshot } from '../../shared/myIssues.js';
import { myIssueUrl } from '../../shared/myIssues.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('github-issue/my-issues-snapshot');

interface SnapshotShape {
  snapshot: MyIssuesSnapshot | null;
}

/**
 * 首屏只需要看得见的那一段 —— fresh 一到就整体接管,存更多只是让文件变大。
 * (合并后的 items 最坏可达账本 500 + 一页 100。)
 */
const MAX_SNAPSHOT_ITEMS = 200;

const VALID_STATES = new Set(['open', 'closed', 'unknown']);
const VALID_SOURCES: MyIssueSource[] = ['cindy-tool', 'github-account'];

let storeInstance: Store<SnapshotShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<SnapshotShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<SnapshotShape>({
      name: 'my-issues-snapshot',
      cwd: currentPath,
      defaults: { snapshot: null },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

/**
 * 清洗**读出来的**条目并返回,不回写 —— 落盘的坏数据不会被自动修好,每次读都重新过滤。
 *
 * 判据与既有三处保持一致(这一族在 #1103 / #1224 里反复漏过,所以照抄判据而不是另立):
 *  - `url` **一律按 number 派生**,不采纳落盘的值。文件可被篡改,而这一页每行都声称
 *    「这是你在本仓提的 issue」、整行点击直接交给 openExternal。
 *  - `createdAt` 必须可被 Date.parse 解析:列表排序直接拿它相减,NaN 会让**整份**顺序
 *    变成未定义(不是「这一条排错位置」)。
 *  - `state` / `sources` 只收合法值,免得渲染出不存在的状态点或来源标记。
 *
 * 纯函数,单测直接调(不碰 electron-store)。
 */
export function normalizeSnapshotItems(value: unknown): MyIssueItem[] {
  if (!Array.isArray(value)) return [];
  const items: MyIssueItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<MyIssueItem>;
    const { number, title, createdAt } = candidate;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== 'string' || title.length === 0) continue;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) continue;
    if (typeof candidate.state !== 'string' || !VALID_STATES.has(candidate.state)) continue;

    const sources = Array.isArray(candidate.sources)
      ? VALID_SOURCES.filter((source) => candidate.sources!.includes(source))
      : [];
    if (sources.length === 0) continue;

    items.push({
      number,
      // 派生,不信落盘值 —— 理由见上面的判据说明。
      url: myIssueUrl(number),
      title,
      type: candidate.type === 'bug' || candidate.type === 'feature' ? candidate.type : null,
      state: candidate.state as MyIssueItem['state'],
      createdAt,
      updatedAt:
        typeof candidate.updatedAt === 'string' && Number.isFinite(Date.parse(candidate.updatedAt))
          ? candidate.updatedAt
          : null,
      commentCount:
        typeof candidate.commentCount === 'number' && Number.isFinite(candidate.commentCount)
          ? candidate.commentCount
          : null,
      sources,
    });
    if (items.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  return items;
}

/** 清洗整份快照;形状不对(含 null)一律当「没有快照」。 */
export function normalizeSnapshot(value: unknown): MyIssuesSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MyIssuesSnapshot>;
  const items = normalizeSnapshotItems(candidate.items);
  const cachedAt =
    typeof candidate.cachedAt === 'string' && Number.isFinite(Date.parse(candidate.cachedAt))
      ? candidate.cachedAt
      : null;
  if (!cachedAt) return null;

  const enhancement = candidate.githubEnhancement;
  const githubEnhancement =
    enhancement &&
    typeof enhancement === 'object' &&
    typeof enhancement.login === 'string' &&
    enhancement.login.length > 0 &&
    (enhancement.source === 'ghost' || enhancement.source === 'gh-cli')
      ? { login: enhancement.login, source: enhancement.source }
      : null;

  return { items, githubEnhancement, cachedAt };
}

/** 读首屏快照;没有 / 坏掉都返回 null,调用方按「首次使用」处理。 */
export function readMyIssuesSnapshot(): MyIssuesSnapshot | null {
  try {
    return normalizeSnapshot(getStore().get('snapshot', null));
  } catch (err) {
    // 读不到快照只是少了首屏加速,绝不能影响这一页能不能用。
    log.warn('reading the my-issues snapshot failed; treating it as absent', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 写首屏快照。调用方(service 的 settle)已经校验过账号作用域 —— 这里只负责落盘。
 * 抛错交给调用方吞掉:快照写不进去不该让一次成功的查询变成失败。
 */
export function writeMyIssuesSnapshot(snapshot: MyIssuesSnapshot): void {
  getStore().set('snapshot', {
    items: snapshot.items.slice(0, MAX_SNAPSHOT_ITEMS),
    githubEnhancement: snapshot.githubEnhancement,
    cachedAt: snapshot.cachedAt,
  });
}

export const __testing = { MAX_SNAPSHOT_ITEMS };
