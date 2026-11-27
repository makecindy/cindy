import { describe, expect, it } from 'vitest';
import type { HostSettingState, HostSettingsSnapshot } from '../../../shared/hostSettings.js';
import { settingsSnapshotDomainsSchema } from '../../../shared/settingsSnapshot.js';
import { projectSettingsSnapshot } from '../snapshotProjection.js';

function ready<T>(value: T, customizedKeys: string[] = []): HostSettingState<T> {
  return { status: 'ready', value, defaults: structuredClone(value), customizedKeys,
    revision: 'private-revision', isCustomized: customizedKeys.length > 0 };
}
function snapshot(): HostSettingsSnapshot {
  return {
    ownerStamp: { dataOwnerId: 'private-owner', ownerGeneration: 42 },
    newTaskDefaults: ready({ harness: 'codex', providerId: 'provider-example', modelId: 'model-example',
      effort: 'high', fast: false, thinking: true, worktree: false, planMode: false }, ['fast', 'planMode']),
    personalization: ready({ isCustomized: true }),
    databaseWarning: ready({ thresholdGiB: 10, disabled: false }, ['thresholdGiB']),
    appearance: ready({ density: 1, motion: 1, terminalFamily: 'PRIVATE-TERMINAL', terminalSize: 13, wallpaperId: 'none', wallpaperOverlay: 0.2, wallpaperMotion: 'static', uiSize: 14, codeSize: 13, windowZoom: 1, uiFamily: 'PRIVATE-FONT-A', codeFamily: 'PRIVATE-FONT-B', appIcon: 'default' }, ['codeFamily']),
  };
}

describe('设置快照白名单投影', () => {
  it('projects ultrafast as enabled on the unchanged boolean CIS wire', () => {
    const input = snapshot();
    if (input.newTaskDefaults.status !== 'ready') throw new Error('fixture');
    input.newTaskDefaults.value.fast = 'ultrafast';
    const output = projectSettingsSnapshot(input);
    expect(settingsSnapshotDomainsSchema.safeParse(output).success).toBe(true);
    expect(output.newTaskDefaults).toMatchObject({ fields: { fast: { value: true } } });
    expect(input.newTaskDefaults.value.fast).toBe('ultrafast');
  });

  it('映射名称、作用域和显式 false 的来源，不把保存值说成运行时状态', () => {
    const result = projectSettingsSnapshot(snapshot());
    expect(settingsSnapshotDomainsSchema.safeParse(result).success).toBe(true);
    expect(result.newTaskDefaults).toMatchObject({ status: 'supported', scope: 'owner', boundary: 'nextTask', fields: {
      harness: { value: 'codex', source: 'default' }, fast: { value: false, source: 'override' },
      plan: { value: false, source: 'override' }, thinking: { value: true, source: 'default' },
    } });
    expect(result.personalization).toMatchObject({ fields: { customized: { value: true, source: 'override' } } });
    expect(result.databaseWarning).toMatchObject({ fields: { thresholdGiB: { value: 10, source: 'override' } } });
    expect(result.appearance).toEqual({ status: 'supported', scope: 'cloudDesktop', boundary: 'immediate', fields: {
      uiFontSize: { value: 14, source: 'default' }, codeFontSize: { value: 13, source: 'default' },
      zoomFactor: { value: 1, source: 'default' }, uiFontCustomized: { value: false, source: 'default' },
      codeFontCustomized: { value: true, source: 'override' },
    } });
  });

  it('不传身份、revision、字体正文、prompt 正文及其 hash，即使输入有额外字段', () => {
    const input = snapshot();
    Object.assign(input, { token: 'PRIVATE-TOKEN', path: '/private/owner', userPrompt: 'PRIVATE-PROMPT' });
    Object.assign(input.personalization, { userPrompt: 'PRIVATE-PROMPT', hash: 'PRIVATE-HASH' });
    if (input.personalization.status === 'ready') Object.assign(input.personalization.value, { userPrompt: 'PRIVATE-PROMPT' });
    const serialized = JSON.stringify(projectSettingsSnapshot(input));
    expect(serialized).not.toMatch(/PRIVATE|private|revision|ownerGeneration|dataOwnerId|defaults|userPrompt|hash/);
  });

  it('v1也只发送有公开目录精确证明的ID，不借旧版降级泄漏自定义名称', () => {
    const raw = snapshot();
    const privateDomain = projectSettingsSnapshot(raw).newTaskDefaults;
    expect(privateDomain).toMatchObject({ status: 'supported' });
    if (privateDomain.status === 'supported') expect(privateDomain.fields).not.toHaveProperty('modelId');
    const proven = projectSettingsSnapshot(raw, { models: new Set(['model-example']), providers: new Set(['provider-example']) }).newTaskDefaults;
    expect(proven).toMatchObject({ fields: { modelId: { value: 'model-example' }, providerId: { value: 'provider-example' } } });
  });

  it('连敏感字体和 prompt 属性也不读取', () => {
    const input = snapshot();
    if (input.appearance.status === 'ready') {
      Object.defineProperty(input.appearance.value, 'uiFamily', { get() { throw new Error('不可读字体正文'); } });
      Object.defineProperty(input.appearance.value, 'codeFamily', { get() { throw new Error('不可读字体正文'); } });
    }
    if (input.personalization.status === 'ready') {
      Object.defineProperty(input.personalization.value, 'userPrompt', { get() { throw new Error('不可读指令正文'); } });
    }
    expect(() => projectSettingsSnapshot(input)).not.toThrow();
  });

  it.each([null, 'https://example.invalid/token', '/private/models', 'vendor/model', 'sk-secret', 'eyJsecret', 'x'.repeat(97)])(
    '省略不安全或不存在的模型/来源 ID：%s', value => {
      const input = snapshot();
      if (input.newTaskDefaults.status !== 'ready') throw new Error('fixture');
      input.newTaskDefaults.value.modelId = value;
      input.newTaskDefaults.value.providerId = value;
      const domain = projectSettingsSnapshot(input).newTaskDefaults;
      expect(domain.status).toBe('supported');
      if (domain.status !== 'supported') throw new Error('fixture');
      expect(domain.fields).not.toHaveProperty('modelId');
      expect(domain.fields).not.toHaveProperty('providerId');
      expect(domain.fields.harness?.value).toBe('codex');
    },
  );

  it.each([null, 'auto', 'private text'])('省略未确定或不支持的 effort：%s', effort => {
    const input = snapshot();
    if (input.newTaskDefaults.status !== 'ready') throw new Error('fixture');
    input.newTaskDefaults.value.effort = effort;
    const result = projectSettingsSnapshot(input).newTaskDefaults;
    expect(result.status).toBe('supported');
    if (result.status === 'supported') expect(result.fields).not.toHaveProperty('effort');
  });

  it.each(['unreadable', 'unavailable'] as const)('坏领域 %s 不伪造默认值、不影响其它领域', status => {
    const input = snapshot();
    input.databaseWarning = { status, revision: null };
    const result = projectSettingsSnapshot(input);
    expect(result.databaseWarning).toEqual({ status: 'unavailable', scope: 'profile', boundary: 'immediate' });
    expect(result.newTaskDefaults.status).toBe('supported');
    expect(result.appearance.status).toBe('supported');
  });

  it('异常数值仅使所属领域不可用，不返回任意坏值', () => {
    const input = snapshot();
    if (input.appearance.status !== 'ready') throw new Error('fixture');
    input.appearance.value.windowZoom = Number.NaN;
    expect(projectSettingsSnapshot(input).appearance).toEqual({ status: 'unavailable', scope: 'cloudDesktop', boundary: 'immediate' });
  });
});
