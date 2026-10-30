/**
 * 供应商分享 · 受邀者这台电脑对每个分享的本机偏好(provider-sharing.md §9 第 7 条)。
 *
 * 目前只有一项：「信任 {分享者}」——用这个分享的任务里读写凭证类文件、执行读取凭证的命令时
 * 不再在本机弹确认卡，与本机任务一致。粒度是一个分享(分享者 × 供应商)，只对这台电脑生效。
 *
 *  - 只存用户显式打开的项(override)；没有记录 = 默认要确认。
 *  - 文件按账号放在 owners/<账号>/provider-share-guest-prefs.json，只含服务端生成的分享 id 与分享
 *    所属区域，不含昵称、对话或凭证。
 *  - 分享被删除或受邀者退出后一起清掉：退出时直接忘掉；分享从已确认区域的权威名单里消失时清掉，
 *    还没加载的区域不动(跨区域分享晚加载时不误删)。
 *  - 没有配置存储位置(测试、未登录)时只留在内存里。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { withSecurityBoundaryLock } from './crossProcessLock.js';

const log = createLogger('provider-share:guest-prefs');

type Region = 'cn' | 'global';

interface GuestPrefRecord {
  region: Region;
  /** 凭证类操作不再在本机确认。只在为 true 时写入。 */
  skipCredentialConsent: true;
}

interface StoredPrefs {
  version: 1;
  shares: Record<string, GuestPrefRecord>;
}

const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/;

interface PendingSetting {
  file: string | null;
  shareId: string;
  region: Region;
  cancelled: boolean;
}

let resolvePath: (() => string) | null = null;
let cache: { file: string | null; shares: Map<string, GuestPrefRecord> } | null = null;
let writes: Promise<void> = Promise.resolve();
let pendingWrites = 0;
let generation = 0;
const pendingSettings = new Set<PendingSetting>();
// 退出或权威名单清理立即撤权；不能等前面的磁盘写入结束才停止跳过确认。
const revokedShares = new Map<string | null, Map<string, object>>();

/** 由本机接线在启动时提供文件位置(按当前账号解析)；传 null 回到只在内存里。 */
export function configureProviderShareGuestPrefs(options: { resolvePath: (() => string) | null }): void {
  resolvePath = options.resolvePath;
  invalidateProviderShareGuestPrefsCache();
}

/**
 * 共享 userData 的另一个 Desktop 实例可能已经改写了同一份偏好文件；
 * device-link 持有权切换时必须丢掉本实例缓存，并使排队/在途写入失效。
 * 已经交给文件系统的 rename 无法取消，由跨进程锁保证它先于新持有者的写入完成。
 */
export function invalidateProviderShareGuestPrefsCache(): void {
  generation += 1;
  cache = null;
}

function currentFile(): string | null {
  try {
    return resolvePath ? resolvePath() : null;
  } catch (error) {
    log.warn('guest prefs path unavailable', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function parse(raw: string): Map<string, GuestPrefRecord> {
  const shares = new Map<string, GuestPrefRecord>();
  const parsed = JSON.parse(raw) as Partial<StoredPrefs> | null;
  if (!parsed || parsed.version !== 1 || !parsed.shares || typeof parsed.shares !== 'object') return shares;
  for (const [shareId, value] of Object.entries(parsed.shares as Record<string, unknown>)) {
    if (!SHARE_ID.test(shareId) || !value || typeof value !== 'object') continue;
    const record = value as Partial<GuestPrefRecord>;
    if ((record.region !== 'cn' && record.region !== 'global') || record.skipCredentialConsent !== true) continue;
    shares.set(shareId, { region: record.region, skipCredentialConsent: true });
  }
  return shares;
}

function readFile(file: string | null): Map<string, GuestPrefRecord> {
  let shares = new Map<string, GuestPrefRecord>();
  if (file) {
    try {
      shares = parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('guest prefs unreadable; treating as none', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return shares;
}

/** 当前账号的偏好；账号(文件位置)变了就重读。读不到按没有偏好处理。 */
function load(file = currentFile()): Map<string, GuestPrefRecord> {
  if (cache && cache.file === file) return cache.shares;
  const shares = readFile(file);
  if (currentFile() === file) cache = { file, shares };
  return shares;
}

function persist(file: string | null, update: (shares: Map<string, GuestPrefRecord>) => boolean): Promise<void> {
  const expectedGeneration = generation;
  const assertCurrent = () => {
    if (generation !== expectedGeneration) throw new Error('Provider share preferences changed during save');
  };
  pendingWrites += 1;
  const write = writes.then(async () => {
    assertCurrent();
    const commit = async () => {
      assertCurrent();
      // 必须在跨进程锁内重读，不能把旧实例缓存中的授权写回新持有者的文件。
      const shares = new Map(file ? readFile(file) : load(file));
      if (update(shares) && file) {
        await writeFile(file, { version: 1, shares: Object.fromEntries(shares) }, assertCurrent);
      }
      assertCurrent();
      if (currentFile() === file) cache = { file, shares };
    };
    if (!file) return commit();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await withSecurityBoundaryLock(`${file}.lock`, { label: 'provider-share-guest-prefs' }, async (status) => {
      if (!status.held) throw new Error('Provider share preferences lock is busy or unavailable');
      await commit();
    });
  });
  writes = write.catch((error) => {
    log.warn('guest prefs write failed', { error: error instanceof Error ? error.message : String(error) });
  }).finally(() => {
    pendingWrites -= 1;
  });
  return write;
}

async function writeFile(file: string, snapshot: StoredPrefs, assertCurrent: () => void): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    assertCurrent();
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** 这个分享的任务里凭证类操作是否不再确认(默认 false)。 */
export function isProviderShareCredentialConsentSkipped(shareId: string): boolean {
  const file = currentFile();
  if (revokedShares.get(file)?.has(shareId)) return false;
  return load(file).get(shareId)?.skipCredentialConsent === true;
}

/** 打开或关掉「信任 {分享者}」。关掉就是删掉记录(只存 override)。 */
export async function setProviderShareCredentialConsent(shareId: string, region: Region, skip: boolean): Promise<void> {
  if (!SHARE_ID.test(shareId)) throw new Error('Invalid provider share id');
  const file = currentFile();
  const setting: PendingSetting = { file, shareId, region, cancelled: false };
  pendingSettings.add(setting);
  try {
    await persist(file, (shares) => {
      if (setting.cancelled) return false;
      if (!skip) return shares.delete(shareId);
      if (shares.get(shareId)?.region === region) return false;
      shares.set(shareId, { region, skipCredentialConsent: true });
      return true;
    });
    if (!setting.cancelled) revokedShares.get(file)?.delete(shareId);
  } finally {
    pendingSettings.delete(setting);
  }
}

/** 在内存中立即撤权，再在同一跨进程锁内删除磁盘记录；失败也不恢复信任。 */
function removePrefs(file: string | null, matches: (shareId: string, region: Region) => boolean): Promise<void> {
  const revoked = revokedShares.get(file) ?? new Map<string, object>();
  revokedShares.set(file, revoked);
  const removal = {};
  for (const setting of pendingSettings) {
    if (setting.file === file && matches(setting.shareId, setting.region)) {
      setting.cancelled = true;
      revoked.set(setting.shareId, removal);
    }
  }
  for (const [shareId, record] of load(file)) {
    if (matches(shareId, record.region)) revoked.set(shareId, removal);
  }
  return persist(file, (shares) => {
    const previousSize = shares.size;
    for (const [shareId, record] of shares) {
      if (matches(shareId, record.region)) shares.delete(shareId);
    }
    return shares.size !== previousSize;
  }).then(() => {
    for (const [shareId, token] of revoked) {
      if (token === removal) revoked.delete(shareId);
    }
    if (revoked.size === 0 && revokedShares.get(file) === revoked) revokedShares.delete(file);
  });
}

/** 绑定退出请求发起时的账号文件，完成退出后只清理该账号的偏好。 */
export function captureProviderShareGuestPrefsRemoval(shareId: string): () => Promise<void> {
  const file = currentFile();
  return () => removePrefs(file, (id) => id === shareId);
}

/** 受邀者退出了这个分享：忘掉它的偏好。 */
export function forgetProviderShareGuestPrefs(shareId: string): Promise<void> {
  return captureProviderShareGuestPrefsRemoval(shareId)();
}

/**
 * 按权威名单清理：只清 `confirmedRegions` 里的区域中已经不在 `present` 的分享，其它区域(还没加载)
 * 的记录原样保留。
 */
export function pruneProviderShareGuestPrefs(present: ReadonlySet<string>, confirmedRegions: readonly Region[]): Promise<void> | void {
  if (confirmedRegions.length === 0) return;
  const file = currentFile();
  if (pendingWrites === 0 && ![...load(file)].some(([shareId, record]) => confirmedRegions.includes(record.region) && !present.has(shareId))) return;
  return removePrefs(file, (shareId, region) => confirmedRegions.includes(region) && !present.has(shareId)).catch(() => undefined);
}

/** 等最近一次写入落盘(测试与退出前用)。 */
export function flushProviderShareGuestPrefs(): Promise<void> {
  return writes;
}

/** 仅测试用：回到初始状态。 */
export function resetProviderShareGuestPrefsForTests(): void {
  resolvePath = null;
  invalidateProviderShareGuestPrefsCache();
  writes = Promise.resolve();
  pendingWrites = 0;
  pendingSettings.clear();
  revokedShares.clear();
}
