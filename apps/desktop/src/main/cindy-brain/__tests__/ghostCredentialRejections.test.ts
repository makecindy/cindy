import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createGhostCredentialRejectionsStore } from '../ghostCredentialRejections';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cred-rej-'));
const filePath = path.join(tmpDir, 'ledger.json');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(filePath, { force: true });
});

describe('ghostCredentialRejections 台账', () => {
  it('记账 / 幂等 / 清账 / 跨实例持久化', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.rejectedKeys('web-search')).toEqual([]);

    expect(store.markRejected('web-search', 'brave_api_key')).toBe(true);
    expect(store.markRejected('web-search', 'brave_api_key')).toBe(false); // 幂等
    expect(store.markRejected('web-search', 'tavily_api_key')).toBe(true);
    expect(store.rejectedKeys('web-search')).toEqual(['brave_api_key', 'tavily_api_key']);

    // 新实例读同一文件 = 持久化生效
    const reloaded = createGhostCredentialRejectionsStore({ filePath });
    expect(reloaded.rejectedKeys('web-search')).toEqual(['brave_api_key', 'tavily_api_key']);

    expect(reloaded.clearSecret('web-search', 'brave_api_key')).toBe(true);
    expect(reloaded.rejectedKeys('web-search')).toEqual(['tavily_api_key']);
    expect(reloaded.clearSecret('web-search', 'brave_api_key')).toBe(false);

    expect(reloaded.clear('web-search')).toBe(true);
    expect(reloaded.clear('web-search')).toBe(false);
    expect(reloaded.rejectedKeys('web-search')).toEqual([]);
  });

  it('损坏的台账文件按空账处理(fail-open),不拖垮判定', () => {
    fs.writeFileSync(filePath, '{not json', 'utf8');
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.rejectedKeys('any')).toEqual([]);
    // 记账仍然可用(覆盖坏文件)
    expect(store.markRejected('any', 'k')).toBe(true);
    expect(store.rejectedKeys('any')).toEqual(['k']);
  });

  it('使用 own-key 查找,并能按连接 identity 清账', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.rejectedKeys('constructor')).toEqual([]);
    expect(store.markRejected('constructor', 'connection:gitlab:connection-1')).toBe(true);
    expect(store.rejectedKeys('constructor')).toEqual(['connection:gitlab:connection-1']);

    expect(store.clearConnection('constructor', 'gitlab', 'connection-1')).toBe(true);
    expect(store.rejectedKeys('constructor')).toEqual([]);
  });
});
