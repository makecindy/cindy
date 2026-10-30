import { describe, expect, it } from 'vitest';

import { resolveTaskModelSwitchDraftWrite } from '../lib/taskModelSwitchDraft';

const base = {
  requestedMarkModelChoice: true,
  agentKind: 'claude-code' as const,
  currentAgentKind: 'claude-code' as const,
  activeProviderId: null as string | null,
  memoryProviderId: null as string | null,
  effectiveSourceId: null as string | null,
  initialProviderId: null as string | null,
};

describe('resolveTaskModelSwitchDraftWrite', () => {
  it('同引擎、写回来源就是任务来源 = 只换模型', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({
        ...base,
        activeProviderId: 'xd',
        memoryProviderId: 'xd',
        effectiveSourceId: 'xd',
      }),
    ).toMatchObject({ modelOnly: true, markModelChoice: true, sourceUnknown: false, taskProviderId: 'xd' });
  });

  it('持久化的显式来源已因 Auto 搬迁过期时，用生效来源识别并写回它', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({
        ...base,
        activeProviderId: 'org-pool',
        initialProviderId: 'org-pool',
        memoryProviderId: 'xd',
        effectiveSourceId: 'xd',
      }),
    ).toMatchObject({ modelOnly: true, taskProviderId: 'xd', draftProviderId: 'xd' });
  });

  it('这次选了别的来源 = 显式换来源，不是只换模型', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({
        ...base,
        activeProviderId: 'anthropic',
        memoryProviderId: 'anthropic',
        effectiveSourceId: 'xd',
      }),
    ).toMatchObject({ modelOnly: false, markModelChoice: true, draftProviderId: 'anthropic' });
  });

  it('跨引擎不算只换模型', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({
        ...base,
        agentKind: 'codex',
        activeProviderId: 'xd',
        memoryProviderId: 'xd',
        effectiveSourceId: 'xd',
      }),
    ).toMatchObject({ modelOnly: false, markModelChoice: true });
  });

  it('任务当前模型被停用(effectiveSourceId 为空)时回退用任务显式来源识别', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({
        ...base,
        activeProviderId: 'xd',
        initialProviderId: 'xd',
      }),
    ).toMatchObject({ modelOnly: true, markModelChoice: true, sourceUnknown: false });
  });

  it('任务来源确认不了且没带显式来源：不打显式选择标记', () => {
    expect(resolveTaskModelSwitchDraftWrite(base)).toMatchObject({
      sourceUnknown: true,
      markModelChoice: false,
      modelOnly: false,
    });
  });

  it('本来就不要求打标的写回(只改档位)保持原样', () => {
    expect(
      resolveTaskModelSwitchDraftWrite({ ...base, requestedMarkModelChoice: false }),
    ).toMatchObject({ markModelChoice: false, modelOnly: false, sourceUnknown: false });
  });
});
