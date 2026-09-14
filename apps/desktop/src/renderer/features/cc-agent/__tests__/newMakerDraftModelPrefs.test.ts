import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveNewMakerDraftEffort } from '../newMakerDraftModelPrefs';

describe('resolveNewMakerDraftEffort', () => {
  it('首页当前显示模型也采用其它对话写入的全局预设', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        presetEffort: 'high',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      }),
    ).toBe('high');
  });

  it('预设不被当前来源支持时回落模型默认', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'low',
        presetEffort: 'xhigh',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      }),
    ).toBe('high');
  });

  it('没有全局预设或目录尚未就绪时保留草稿原值', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      }),
    ).toBe('medium');
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        presetEffort: 'high',
        efforts: [],
        defaultEffort: null,
      }),
    ).toBe('medium');
  });

  /**
   * 2026-08-12 登录态沙盒实证:服务端把 DeepSeek V4 Pro 下发为新用户默认种子
   * (目录 newSessionDefault 标记),它的档位表只有 ['high','max']、defaultEffort='high';
   * 而草稿的种子档来自 newMakerDraft.defaultVendorPrefs 里写死的 'medium' —— 两者毫无关系。
   * 旧实现在「没有全局预设」时直接把 currentEffort 原样交出去,于是新用户第一屏就带着一个
   * 该模型根本不支持的档:pill 上是「中」,createSession 也会把它提交上去。
   */
  it('新用户种子档不在模型档位表里时校准到目录默认(DeepSeek V4 Pro:high/max-only)', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['high', 'max'],
        defaultEffort: 'high',
      }),
    ).toBe('high');
  });

  it('种子档失配且模型没给 defaultEffort 时取表内最接近档', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['high', 'max'],
        defaultEffort: null,
      }),
    ).toBe('high');
  });

  /**
   * 同一条规则也管老用户:lastByVendor 里记的档是跨模型的偏好,服务端改了某个模型的档位表
   * 之后,那份记忆落到这个模型上就是失效值 —— 不能因为「它不是种子而是用户记忆」就放行。
   */
  it('老用户 lastByVendor 记忆档落到换了档位表的模型上时同样被校准', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['low', 'xhigh'],
        defaultEffort: null,
      }),
      // low 距 medium 一档、xhigh 距两档 → low。
    ).toBe('low');
  });

  it('最接近档距离相同时取更低的一档(降级可逆,升级会静默多花钱)', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['low', 'high'],
        defaultEffort: null,
      }),
    ).toBe('low');
  });

  it('草稿当前档本就受支持时一动不动(不因为引入校准就乱改用户的档)', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'high',
        efforts: ['high', 'max'],
        defaultEffort: 'max',
      }),
    ).toBe('high');
  });

  it('全局预设仍然优先于草稿当前档(校准不改变优先级)', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'high',
        presetEffort: 'max',
        efforts: ['high', 'max'],
        defaultEffort: 'high',
      }),
    ).toBe('max');
  });
});

/**
 * 纯函数修对了还不够:它的输入必须来自**校准后**的 (来源, 模型),且它的输出必须同时喂
 * 显示与提交。任一半接错,DeepSeek 那个 bug 就会以另一种形态复活(pill 对了但发出去的
 * effort 还是脏的,或者反过来)。
 */
describe('NewMakerDraftRoute 的档位校准接线', () => {
  const routeSource = readFileSync(resolve(__dirname, '..', 'NewMakerDraftRoute.tsx'), 'utf8');

  it('档位表取自校准后的模型,不是草稿里那个种子模型', () => {
    expect(routeSource).toContain(
      'getModel(provider, calibratedDraftModel, capabilityAgentKind)',
    );
    expect(routeSource).toContain('efforts: model?.efforts ?? [],');
    expect(routeSource).toContain('defaultEffort: model?.defaultEffort ?? null,');
    // 种子档与全局预设都作为输入交给规则,由它裁决 —— 调用方不自己短路。
    expect(routeSource).toContain('currentEffort: chatPrefs.effort,');
  });

  it('校准后的档同时喂 composer 显示与 createSession 提交', () => {
    // 显示:draftInitialEffort → ChatInput.initialEffort → pill。
    expect(routeSource).toContain('return { model: calibratedDraftModel, effort: localDraftEffort };');
    // 提交:两条 createSession 组装都用同一个值,不得回退 chatPrefs.effort。
    expect(routeSource.match(/effort: draftInitialEffort,/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
