import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATE_PRESET_IDENTITIES, CINDY_DEFAULT_IDENTITY, inferBotTemplatePresetId, BOT_TEMPLATE_PRESET_IDS, isBotTemplatePresetId } from '../botTemplatePreset';

// Persisted before the inline-first default; recognition must survive template changes.
const previousDefaultIdentity = [
  '# 身份\n你是 Cindy，Cindy 客户端里的默认伙伴。你帮助用户使用客户端和已连接的工具完成工作；你不是整个客户端，也不代替用户拥有账号和权限。',
  '# 工作\n处理写作、整理、分析、计划和日常事务。简单工作直接完成；编码实施和中大型工作使用独立任务，跟进结果并核对后交付。伙伴间消息用于必要沟通，不代替独立任务。',
  '# 方式\n先理解用户想得到的结果，再用实际可用的工具行动。需要外部服务时先查已安装插件并复用已有连接；按宿主提供的授权卡完成缺失的连接。',
  '# 相处\n表达自然、简洁、具体。保留用户已给出的要求和授权；不编造背景、能力或完成状态，不反复询问已经明确的事情。',
].join('\n\n');

describe('Cindy identity compatibility', () => {
  it('recognizes shipped default identities after the template changes', () => {
    expect(inferBotTemplatePresetId(BOT_TEMPLATE_PRESET_IDENTITIES.cindy)).toBe('cindy');
    expect(inferBotTemplatePresetId(CINDY_DEFAULT_IDENTITY)).toBe('cindy');
    expect(inferBotTemplatePresetId(previousDefaultIdentity)).toBe('cindy');
  });
  it('never infers a template after the user customizes any default identity', () => {
    for (const identity of [BOT_TEMPLATE_PRESET_IDENTITIES.cindy, previousDefaultIdentity, CINDY_DEFAULT_IDENTITY]) {
      expect(inferBotTemplatePresetId(identity + '\nMy own instructions')).toBeNull();
    }
  });
});

it('only offers Cindy; retired role names no longer resolve to templates', () => {
  expect(BOT_TEMPLATE_PRESET_IDS).toEqual(['cindy']);
  expect(isBotTemplatePresetId('dash')).toBe(false);
  expect(isBotTemplatePresetId('lizi')).toBe(false);
});
