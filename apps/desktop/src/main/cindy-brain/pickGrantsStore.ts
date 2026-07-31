/**
 * pickGrantsStore —— pick 槽「用户亲选目录」台账的持久化。
 *
 * File: <userData>/ghost-pick-grants.json
 *
 * 形态:{ grants: { <ghostId>: [归一化绝对路径, ...] } }(新选的排前面)。
 *
 * 为什么要台账:pick 槽把绝对路径交给插件后,主机自己不再记得"用户亲手
 * 选过哪个目录"。而 errand 等能力允许插件在请求里**转述**一个目录时,必须
 * 有一个宿主侧的可信事实来对账——插件沙箱里的任何值都不构成授权。台账里
 * 的每一条都对应一次用户在系统选目录窗口里的亲手点选(与确认卡点允许同
 * 强度),所以"转述的目录 ∈ 台账"才放行。
 *
 * 语义边界:
 * - 只记 pick 槽成功交付的目录(取消/失败不记);
 * - 路径统一走 normalizeWorkingDirForStorage 归一化后存取,比对永不受
 *   尾斜杠/分隔符差异干扰;
 * - 每插件保留最近 GRANTS_PER_GHOST 条(重选同目录只提位,不重复);
 * - 抽离插件**不**清台账——与 errand 配置、dirDeposit"同插件永久生效"
 *   同一哲学:用户亲选的事实不因重装而消失。
 */

import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('pick-grants-store');

/** 每插件保留的亲选目录条数(超出淘汰最旧;够覆盖"换过几次项目目录")。 */
export const GRANTS_PER_GHOST = 8;
/** 单条路径长度上限(与 errand 配置 workingDir 同口径)。 */
const MAX_DIR_LEN = 1024;

interface GhostPickGrants {
  grants: Record<string, string[]>;
}

const DEFAULTS: GhostPickGrants = { grants: {} };

function normalize(raw: unknown): GhostPickGrants {
  if (!raw || typeof raw !== 'object') return { grants: {} };
  const grantsRaw = (raw as { grants?: unknown }).grants;
  const grants: GhostPickGrants['grants'] = {};
  if (grantsRaw && typeof grantsRaw === 'object') {
    for (const [ghostId, listRaw] of Object.entries(grantsRaw as Record<string, unknown>)) {
      if (!Array.isArray(listRaw)) continue;
      const list: string[] = [];
      for (const item of listRaw) {
        if (typeof item !== 'string' || item.length === 0 || item.length > MAX_DIR_LEN) continue;
        const dir = normalizeWorkingDirForStorage(item);
        if (dir && !list.includes(dir)) list.push(dir);
        if (list.length >= GRANTS_PER_GHOST) break;
      }
      if (list.length > 0) grants[ghostId] = list;
    }
  }
  return { grants };
}

const store = createOverrideSettingsFile<GhostPickGrants>({
  filePath: () => ownerScopedUserDataPath('ghost-pick-grants.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-pick-grants',
});

/** 记一笔亲选目录(pick 槽成功交付时调用;重选同目录提位到最前)。 */
export function recordGhostPickedDir(ghostId: string, dirAbs: string): void {
  const dir = normalizeWorkingDirForStorage(dirAbs);
  if (!dir || dir.length > MAX_DIR_LEN) return;
  store.invalidateIfChanged();
  const grants = { ...store.read().grants };
  const list = [dir, ...(grants[ghostId] ?? []).filter((d) => d !== dir)].slice(
    0,
    GRANTS_PER_GHOST,
  );
  grants[ghostId] = list;
  store.writePatch({ grants });
  log.info('ghost picked dir recorded', { ghostId, dirs: list.length });
}

/** 这个目录是不是该插件的用户亲选过的(入参先归一化再比对)。 */
export function isGhostPickedDir(ghostId: string, dirAbs: string): boolean {
  const dir = normalizeWorkingDirForStorage(dirAbs);
  if (!dir) return false;
  store.invalidateIfChanged();
  return (store.read().grants[ghostId] ?? []).includes(dir);
}

export const __testing = { normalize };
