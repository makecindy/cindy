import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  applyGhostSetupChangeToRejections,
  createGhostCredentialRejectionsStore,
  ghostConnectionRejectionRef,
} from '../ghostCredentialRejections';
import { foldRejectedSecretsIntoAssessment } from '../ghostSetupStatus';

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

  it('读取结果不会泄露内部缓存数组', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.markRejected('web-search', 'brave_api_key')).toBe(true);

    const returnedKeys = store.rejectedKeys('web-search') as string[];
    returnedKeys.push('injected_key');

    expect(store.rejectedKeys('web-search')).toEqual(['brave_api_key']);
  });
});

describe('applyGhostSetupChangeToRejections 兜底清账', () => {
  it('secret 事件按 ref 精确清账,不动同插件其它被拒 key', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    store.markRejected('web-search', 'brave_api_key');
    store.markRejected('web-search', 'tavily_api_key');

    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: 'web-search',
        source: 'secret',
        ref: 'brave_api_key',
      }),
    ).toBe(true);
    expect(store.rejectedKeys('web-search')).toEqual(['tavily_api_key']);

    // 幂等:同一事件重放不再产生变化
    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: 'web-search',
        source: 'secret',
        ref: 'brave_api_key',
      }),
    ).toBe(false);
  });

  it('connection 事件带 connectionId 时按连接 identity 清账', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    store.markRejected('cindy-gitlab', ghostConnectionRejectionRef('gitlab', 'conn-1'));
    store.markRejected('cindy-gitlab', ghostConnectionRejectionRef('gitlab', 'conn-2'));

    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: 'cindy-gitlab',
        source: 'connection',
        ref: 'gitlab:conn-1',
      }),
    ).toBe(true);
    expect(store.rejectedKeys('cindy-gitlab')).toEqual([
      ghostConnectionRejectionRef('gitlab', 'conn-2'),
    ]);
  });

  it('connection 事件只带 declKey 时不清账(定位不到具体连接)', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    const ref = ghostConnectionRejectionRef('gitlab', 'conn-1');
    store.markRejected('cindy-gitlab', ref);

    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: 'cindy-gitlab',
        source: 'connection',
        ref: 'gitlab',
      }),
    ).toBe(false);
    expect(store.rejectedKeys('cindy-gitlab')).toEqual([ref]);
  });

  it('emitAll 的空 ghostId 唤醒信号不触碰任何台账', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    store.markRejected('', 'stray_key'); // 就算历史上存在空 id 的账也不该被它清
    store.markRejected('web-search', 'brave_api_key');

    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: '',
        source: 'secret',
        ref: 'brave_api_key',
      }),
    ).toBe(false);
    expect(store.rejectedKeys('')).toEqual(['stray_key']);
    expect(store.rejectedKeys('web-search')).toEqual(['brave_api_key']);
  });

  it('无 ref 或非凭证类来源不清账', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    store.markRejected('web-search', 'brave_api_key');

    expect(
      applyGhostSetupChangeToRejections(store, { ghostId: 'web-search', source: 'secret' }),
    ).toBe(false);
    expect(
      applyGhostSetupChangeToRejections(store, {
        ghostId: 'web-search',
        source: 'host_config',
        ref: 'brave_api_key',
      }),
    ).toBe(false);
    expect(store.rejectedKeys('web-search')).toEqual(['brave_api_key']);
  });
});

/**
 * 存量安装升级契约(plugin-security-and-authoring.md 第 5 节红线)。
 *
 * 本台账是这条链路唯一新增的落盘物。老版本的 userData 里没有这个文件,升级后
 * 用户什么都不做时必须仍然照旧可用——空账、不降级、不要求重新配置。
 */
describe('存量安装升级:台账缺失即空账,不降级已配置的插件', () => {
  it('旧布局(台账文件不存在)→ 空账,已满足的判定原样放行', () => {
    expect(fs.existsSync(filePath)).toBe(false); // 老版本 userData 的真实形态
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.rejectedKeys('web-search')).toEqual([]);
    // 读一次不会顺手把文件创建出来(老版本回退后看到的目录形态不变)
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('无台账时折算是恒等变换:ready 不会被折成 required', () => {
    const store = createGhostCredentialRejectionsStore({ filePath });
    const assessment = {
      state: 'ready' as const,
      revision: 0,
      groups: [
        {
          id: 'manifest:1',
          mode: 'any_of' as const,
          items: [
            {
              ref: 'secret:brave_api_key',
              kind: 'secret' as const,
              label: 'Brave API Key',
              state: 'satisfied' as const,
              actions: [],
            },
          ],
        },
      ],
    };
    expect(
      foldRejectedSecretsIntoAssessment(assessment, store.rejectedKeys('web-search')),
    ).toBe(assessment);
  });

  it('未知字段被忽略而不判损坏(新版写出的台账回退到旧版仍可读)', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ghosts: { 'web-search': ['brave_api_key'] }, futureField: { v: 2 } }),
      'utf8',
    );
    const store = createGhostCredentialRejectionsStore({ filePath });
    expect(store.rejectedKeys('web-search')).toEqual(['brave_api_key']);
  });
});
