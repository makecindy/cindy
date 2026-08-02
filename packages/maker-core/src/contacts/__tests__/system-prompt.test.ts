import { describe, expect, it } from 'vitest';

import { CONTACTS_RULES_DISABLED, CONTACTS_RULES_ENABLED } from '../system-prompt.js';

/**
 * 两态 contacts prompt 段的内容契约(防文案重构时丢关键锚点):
 *  - 开态必须指向 cindy_contacts 工具与 resolve-first / pending 语义
 *  - 关态必须给出确切设置路径(agent 只能口头指路), 且带防唠叨约束
 */
describe('contacts system prompt segments', () => {
  it('enabled 段指向工具入口与写入纪律', () => {
    expect(CONTACTS_RULES_ENABLED).toContain('cindy_contacts');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_resolve');
    expect(CONTACTS_RULES_ENABLED).toContain('status:"pending"');
  });

  it('enabled 段包含显式管理请求的分阶段流程与系统回写护栏', () => {
    expect(CONTACTS_RULES_ENABLED).toContain('Guided contact management');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_stats');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_create_group');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_set_group_members');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_export_system');
    expect(CONTACTS_RULES_ENABLED).toContain('dry_run:true');
    expect(CONTACTS_RULES_ENABLED).toContain('system_group');
    expect(CONTACTS_RULES_ENABLED).toContain('Only if `contacts_export_system` is available (macOS)');
    expect(CONTACTS_RULES_ENABLED).toContain('contacts_export_vcf');
    expect(CONTACTS_RULES_ENABLED).toContain('without claiming it is supported');
    expect(CONTACTS_RULES_ENABLED).toContain('never silently delete system contacts');
    expect(CONTACTS_RULES_ENABLED).toContain('cindy_scheduler');
  });

  it('disabled 段给出设置路径与每会话至多一次的约束', () => {
    expect(CONTACTS_RULES_DISABLED).toContain('Settings → Personalization → Smart Contacts');
    expect(CONTACTS_RULES_DISABLED).toContain('设置 → 个性化 → 智能通讯录');
    expect(CONTACTS_RULES_DISABLED).toContain('At most one such reminder per session');
  });

  it('两段互斥且都非空(trim 后)', () => {
    expect(CONTACTS_RULES_ENABLED.length).toBeGreaterThan(0);
    expect(CONTACTS_RULES_DISABLED.length).toBeGreaterThan(0);
    expect(CONTACTS_RULES_ENABLED).not.toBe(CONTACTS_RULES_DISABLED);
  });
});
