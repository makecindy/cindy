/**
 * modelPickerSheetModel 单测:back 两段式结算、二级标题派生、options 目标行现查与失效回退、
 * flat query 过滤。纯逻辑,node env。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { MobileModelOption } from '@cindy/maker-shared/agent-capabilities';
import type { ProviderView } from '@cindy/model-providers/registry';

import { i18n } from '@/i18n';
import type { ProviderModelRow } from '@/session/providerModelSections';
import {
  filterFlatModelOptions,
  findOptionsTarget,
  modelPickerSheetTitle,
  settleModelPickerSheetBack,
} from '@/session/modelPickerSheetModel';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const provider = { id: 'xd', name: 'XD Gateway' } as unknown as ProviderView;

const row = (providerId: string, modelId: string, displayName: string): ProviderModelRow => ({
  provider: { ...provider, id: providerId } as ProviderView,
  model: {
    id: modelId,
    displayName,
    efforts: ['medium', 'high'] as never,
    defaultEffort: 'medium' as never,
    contextWindow: 200000,
  },
});

const flat = (id: string, label: string): MobileModelOption => ({
  id,
  label,
  efforts: ['medium'],
  effortDisplayNames: {},
  defaultEffort: 'medium',
  supportsFastMode: false,
});

describe('settleModelPickerSheetBack —— 返回两段式(二级先回一级)', () => {
  it('models → 允许关闭', () => {
    expect(settleModelPickerSheetBack({ kind: 'models' })).toEqual({
      next: { kind: 'models' },
      close: true,
    });
  });
  it('options / permission → 回一级,不关闭', () => {
    expect(
      settleModelPickerSheetBack({ kind: 'options', providerId: 'xd', modelId: 'm' }),
    ).toEqual({ next: { kind: 'models' }, close: false });
    expect(settleModelPickerSheetBack({ kind: 'permission' })).toEqual({
      next: { kind: 'models' },
      close: false,
    });
  });
});

describe('findOptionsTarget —— 目标行现查', () => {
  const rows = [row('xd', 'claude-opus-4-8', 'Opus 4.8'), row('openai', 'gpt-5.5', 'GPT-5.5')];
  const flats = [flat('legacy-model', 'Legacy')];

  it('供应商分段行按 (providerId, modelId) 双键找', () => {
    const target = findOptionsTarget(
      { kind: 'options', providerId: 'xd', modelId: 'claude-opus-4-8' },
      rows,
      flats,
    );
    expect(target?.displayName).toBe('Opus 4.8');
    expect(target?.provider?.id).toBe('xd');
    expect(target?.contextWindow).toBe(200000);
  });

  it('同 modelId 不同来源不串(providerId 必须精确匹配)', () => {
    expect(
      findOptionsTarget({ kind: 'options', providerId: 'anthropic', modelId: 'claude-opus-4-8' }, rows, flats),
    ).toBeNull();
  });

  it('flat 行(providerId null)按 id 找;无上下文数据 contextWindow=0', () => {
    const target = findOptionsTarget(
      { kind: 'options', providerId: null, modelId: 'legacy-model' },
      rows,
      flats,
    );
    expect(target?.displayName).toBe('Legacy');
    expect(target?.provider).toBeNull();
    expect(target?.contextWindow).toBe(0);
  });

  it('providers 目录刷新后目标行消失 → null(组件据此自动回一级)', () => {
    expect(
      findOptionsTarget({ kind: 'options', providerId: 'xd', modelId: 'gone' }, rows, flats),
    ).toBeNull();
  });

  it('非 options 视图 → null', () => {
    expect(findOptionsTarget({ kind: 'models' }, rows, flats)).toBeNull();
    expect(findOptionsTarget({ kind: 'permission' }, rows, flats)).toBeNull();
  });
});

describe('modelPickerSheetTitle', () => {
  const rows = [row('xd', 'claude-opus-4-8', 'Opus 4.8')];
  it('models → 「模型」;permission → 「权限」', () => {
    expect(modelPickerSheetTitle({ kind: 'models' }, rows, [])).toBe('模型');
    expect(modelPickerSheetTitle({ kind: 'permission' }, rows, [])).toBe('权限');
  });
  it('options → displayName;目标失效回退 modelId', () => {
    expect(
      modelPickerSheetTitle({ kind: 'options', providerId: 'xd', modelId: 'claude-opus-4-8' }, rows, []),
    ).toBe('Opus 4.8');
    expect(
      modelPickerSheetTitle({ kind: 'options', providerId: 'xd', modelId: 'gone' }, rows, []),
    ).toBe('gone');
  });
});

describe('filterFlatModelOptions —— label/id 大小写不敏感包含', () => {
  const options = [flat('gpt-5.5', 'GPT-5.5'), flat('gpt-5.4', 'GPT-5.4'), flat('claude-x', 'Claude X')];
  it('空 query 返回全量拷贝', () => {
    const out = filterFlatModelOptions(options, '  ');
    expect(out).toHaveLength(3);
    expect(out).not.toBe(options);
  });
  it('命中 label 或 id', () => {
    expect(filterFlatModelOptions(options, '5.4').map((o) => o.id)).toEqual(['gpt-5.4']);
    expect(filterFlatModelOptions(options, 'CLAUDE').map((o) => o.id)).toEqual(['claude-x']);
    expect(filterFlatModelOptions(options, '不存在')).toHaveLength(0);
  });
});
