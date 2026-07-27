import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { localizeAgentStatus } from '@/features/cc-agent/lib/localizeAgentStatus';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('localizeAgentStatus', () => {
  it('localizes Cindy-owned static status labels', () => {
    expect(localizeAgentStatus('Thinking...', i18n.t)).toBe('正在思考…');
    expect(localizeAgentStatus('Editing files...', i18n.t)).toBe('正在编辑文件…');
    expect(localizeAgentStatus('Done', i18n.t)).toBe('已完成');
  });

  it('keeps the command or tool name while localizing the running suffix', () => {
    expect(localizeAgentStatus('powershell running...', i18n.t)).toBe('powershell 运行中…');
    expect(localizeAgentStatus('mcp__cindy__tool running…', i18n.t)).toBe(
      'mcp__cindy__tool 运行中…',
    );
  });

  it('preserves arbitrary vendor status text verbatim', () => {
    expect(localizeAgentStatus('Still running', i18n.t)).toBe('Still running');
    expect(localizeAgentStatus('正在检查测试', i18n.t)).toBe('正在检查测试');
  });
});
