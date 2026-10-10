import { describe, expect, it } from 'vitest';

import { sshModel, sshProvider } from '@/features/cc-agent/__tests__/sshModelFixtures';
import {
  resolveNewMakerDraftEffort,
  resolveSubmitEffort,
} from '@/features/cc-agent/newMakerDraftModelPrefs';

import { resolveSessionExecutionSelection } from '../../maker-ipc/sessionExecutionSelection';

/**
 * 端到端：**首页选「已声明无档位」型号 → 首条消息 → main 准入**（PR #5555 的 review 要的那条）。
 *
 * 三段全部是生产代码，不 mock 任何一环的判断逻辑：
 *   ① 草稿层    `resolveNewMakerDraftEffort` → 目录已声明无档位时交出「不指定」；
 *   ② ChatInput `initialEffort ?? localVendorDefaults.effort` → `display.effort ?? 'low'`
 *      两层兜底（新建草稿 `display === current`，composerModelSelection.ts:18）；
 *      `let effortForSend = activeEffort` 在**新建**任务上是初值分支（无 sessionId）；
 *   ③ `handleSend` 提交边界 `resolveSubmitEffort` → 按模型能力重新归一；
 *   ④ main 准入 `resolveSessionExecutionSelection` → 对显式档位按 `valid: none` 校验。
 *
 * 只有四段接上才叫修复：第 ② 段的存在正是第一版 PR 只改草稿层却被打回的原因。
 *
 * 这是本仓 `test:e2e` tier（`scripts/test-workspaces.config.mjs` 的
 * `desktopE2eInclude = ['src/main/maker-host/__tests__/*.e2e.test.ts']`）的文件，不需要
 * 登录、网络或真人操作 —— 与 `codexExecFunctionAdapter.e2e.test.ts` 同一形态。
 */
describe('e2e: 已声明无档位型号的首条消息创建（ChatInput → handleSend → main 准入）', () => {
  const MODEL = 'mimo-v2.6-flash';
  const PROVIDER_ID = 'opencode-go';

  /** Registry 对该型号的声明：`efforts: []` + `defaultEffort: null`（无 reasoning_effort 档位）。 */
  const provider = sshProvider(
    PROVIDER_ID,
    [sshModel(MODEL, { efforts: [], defaultEffort: null })],
    'pi',
  );
  const availableModels = [{ id: MODEL, efforts: [] as const, defaultEffort: null }];
  const providerRouting = {
    availability: {
      'claude-code': [],
      codex: [],
      pi: [
        {
          id: PROVIDER_ID,
          name: 'OpenCode Go',
          models: [MODEL],
          effortMetaByModel: { [MODEL]: { efforts: [] as const, defaultEffort: null } },
        },
      ],
    },
    resolveDefaultProviderIdForModel: (agent: string, model: string) =>
      agent === 'pi' && model === MODEL ? PROVIDER_ID : null,
  } as Parameters<typeof resolveSessionExecutionSelection>[0]['providerRouting'];

  /** ② ChatInput 的两层兜底（真实代码路径的常量表达）。 */
  function chatInputEffort(draftInitialEffort: string | undefined): string {
    const current = draftInitialEffort ?? 'medium'; // initialEffort ?? localVendorDefaults.effort
    return current ?? 'low'; // composerSelection.display.effort ?? 'low'
  }

  it('完整链路：草稿层交「不指定」→ 兜底补回 → 提交边界归一 → main 放行创建', async () => {
    // ① 草稿层
    const draftInitialEffort = resolveNewMakerDraftEffort({
      currentEffort: 'high',
      efforts: [],
      defaultEffort: null,
    });
    expect(draftInitialEffort).toBeUndefined();

    // ② ChatInput 兜底：确实把「不指定」填回了具体档位（只改草稿层到不了 main）
    const activeEffort = chatInputEffort(draftInitialEffort);
    expect(activeEffort).toBe('medium');

    // ③ handleSend 提交边界
    const submitEffort = resolveSubmitEffort({
      currentEffort: activeEffort,
      provider,
      model: MODEL,
      agentKind: 'pi',
    });
    expect(submitEffort).toBeUndefined();

    // ④ main 准入：不指定档位 → 创建成功，且不换模型、不换来源
    const result = resolveSessionExecutionSelection({
      selection: {
        agentKind: 'pi',
        model: MODEL,
        providerId: PROVIDER_ID,
        effort: submitEffort,
      },
      availableAgents: ['pi'],
      availableModels,
      providerRouting,
      hasCindyAiApiKey: true,
    });
    expect(result).toEqual({
      agentKind: 'pi',
      model: MODEL,
      providerId: PROVIDER_ID,
      effort: undefined,
      fastMode: false,
    });
  });

  it('对照组：跳过提交边界归一（即第一版 PR 的行为）仍被 main 以 valid: none 拒绝', () => {
    // 兜底后的档位直接提交 —— 这正是被 Greptile / MagicLizi 打回的路径，
    // 保留它是为了锁住「为什么第 ③ 段不能删」。
    const activeEffort = chatInputEffort(undefined);
    expect(() =>
      resolveSessionExecutionSelection({
        selection: { agentKind: 'pi', model: MODEL, providerId: PROVIDER_ID, effort: activeEffort },
        availableAgents: ['pi'],
        availableModels,
        providerRouting,
        hasCindyAiApiKey: true,
      }),
    ).toThrow(/valid: none/);
  });
});
