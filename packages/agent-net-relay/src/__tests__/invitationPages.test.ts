/**
 * 测试价值
 * - 生产入口与结果：公网共享任务与供应商分享页面资产（agentNetInvitationAsset）交付土耳其语前端脚本与文案。
 * - Bug 依据：2026-11-12 Review，土耳其语系统下打开共享任务或供应商分享链接时前端未匹配 tr 语言，直接回退英文。
 * - 现有覆盖缺口：invitationScript 与 providerShareInvitationScript 原先仅覆盖 en/zh/ja/ko，无针对 tr 分支及文案的断言。
 * - 最小失败输入：language 为 "tr" / "tr-TR"，期望命中 Turkish copy 数组与 guidance。
 * - tier：unit，纯内存资产断言，耗时 < 50ms。
 */
import { describe, expect, it } from 'vitest';
import { agentNetInvitationAsset } from '@cindy/device-link-sharing/pages';

describe('agentNetInvitationAsset localization', () => {
  it('supplies Turkish copy and locale routing in shared-task join script', () => {
    const asset = agentNetInvitationAsset('shared-task', 'join.js');
    expect(asset).not.toBeNull();
    const script = String(asset?.body);
    expect(script).toContain("language.startsWith('tr') ? 'tr' : 'en'");
    expect(script).toContain('"tr": ["Cindy açılıyor"');
    expect(script).toContain("'tr': ['Cindy’de paylaşılan bir göreve katılın'");
  });

  it('supplies Turkish copy and locale routing in provider-share join script', () => {
    const asset = agentNetInvitationAsset('provider-share', 'join.js');
    expect(asset).not.toBeNull();
    const script = String(asset?.body);
    expect(script).toContain("language.startsWith('tr') ? 'tr' : 'en'");
    expect(script).toContain("'tr': ['Cindy açılıyor'");
    expect(script).toContain('Ayarlar → Sağlayıcılar → Benimle Paylaşılan Sağlayıcılar');
  });
});
