/** 七分钟内的审批弹窗归属；只存电脑、供应商、非秘密链接标识与截止时刻，不存口令、申请或身份。 */
import { PROVIDER_SHARE_LINK_TTL_MS } from '@cindy/device-link';

import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const log = createLogger('provider-share:approval-windows');

/** 两侧共用：链接五分钟有效，再给申请拉取留两分钟；过期不重建、不延长。 */
export const PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS = PROVIDER_SHARE_LINK_TTL_MS + 2 * 60_000;

export interface ProviderShareApprovalQuietLink {
  providerId: string;
  linkId: string;
  until: number;
}

export interface ProviderShareApprovalWatch {
  hostDeviceId: string;
  providerId: string;
  linkId?: string;
  until: number;
}

export interface ProviderShareApprovalWindows {
  quietUntil: Record<string, number>;
  /** Exact-link ownership for servers that return linkId; legacy watches omit it. */
  quietLinks?: ProviderShareApprovalQuietLink[];
  watches: ProviderShareApprovalWatch[];
}

const empty = (): ProviderShareApprovalWindows => ({ quietUntil: {}, watches: [] });
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validLinkId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function normalize(raw: unknown): ProviderShareApprovalWindows {
  const input = raw as Partial<ProviderShareApprovalWindows> | null;
  const now = Date.now();
  const validUntil = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && value > now && value <= now + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
  const quiet = input?.quietUntil;
  const quietUntil = Object.fromEntries(Object.entries(quiet && typeof quiet === 'object' && !Array.isArray(quiet) ? quiet : {})
    .filter(([providerId, until]) => validId(providerId) && validUntil(until)));
  const watches = new Map<string, ProviderShareApprovalWindows['watches'][number]>();
  for (const item of Array.isArray(input?.watches) ? input.watches : []) {
    if (!item || !validId(item.hostDeviceId) || !validId(item.providerId) || !validUntil(item.until)) continue;
    if (item.linkId !== undefined && !validLinkId(item.linkId)) continue;
    const linkId = item.linkId;
    const key = JSON.stringify([item.hostDeviceId, item.providerId, linkId ?? null]);
    const previous = watches.get(key);
    const watch = { hostDeviceId: item.hostDeviceId, providerId: item.providerId, ...(linkId ? { linkId } : {}), until: item.until };
    if (!previous || previous.until < watch.until) watches.set(key, watch);
  }
  const quietLinks = new Map<string, ProviderShareApprovalQuietLink>();
  for (const item of Array.isArray(input?.quietLinks) ? input.quietLinks : []) {
    if (!item || !validId(item.providerId) || !validLinkId(item.linkId) || !validUntil(item.until)) continue;
    const key = JSON.stringify([item.providerId, item.linkId]);
    const previous = quietLinks.get(key);
    if (!previous || previous.until < item.until) quietLinks.set(key, { providerId: item.providerId, linkId: item.linkId, until: item.until });
  }
  return { quietUntil, ...(quietLinks.size > 0 ? { quietLinks: [...quietLinks.values()] } : {}), watches: [...watches.values()] };
}

function createStore(options: { filePath: () => string; scopeKey: () => string }) {
  return createOverrideSettingsFile<ProviderShareApprovalWindows>({
    ...options,
    defaults: empty,
    normalize,
    log,
    label: 'provider-share-approval-windows',
    maxBytes: 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
}

let store: ReturnType<typeof createStore> | null = null;

/** 启动接线注入当前账号路径；没有配置的测试仍只用内存，不在 import 时读写磁盘。 */
export function configureProviderShareApprovalWindows(options: { filePath: () => string; scopeKey: () => string } | null): void {
  store = options ? createStore(options) : null;
}

export function readProviderShareApprovalWindows(): ProviderShareApprovalWindows | null {
  if (!store) return null;
  store.invalidateIfChanged();
  // 缓存命中时也重新过滤已经过期的记录。
  return normalize(store.read());
}

export async function updateProviderShareApprovalWindows(
  update: (current: ProviderShareApprovalWindows) => ProviderShareApprovalWindows,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  if (store) {
    try {
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        return update(normalize(value));
      }, { preserveDefaults: true });
    } catch (error) {
      // 不把文件路径或底层错误原文交给 Renderer / 另一台电脑。
      const code = (error as NodeJS.ErrnoException | null)?.code;
      log.warn('approval window save failed', { code: typeof code === 'string' ? code : 'UNKNOWN' });
      throwIpcError('PRECONDITION_FAILED', 'Could not save provider share approval ownership');
    }
  }
  assertCurrent();
}
