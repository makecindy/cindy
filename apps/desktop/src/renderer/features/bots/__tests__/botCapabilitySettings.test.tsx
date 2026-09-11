// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile } from '../botStore';

const h = vi.hoisted(() => ({
  offLocal: vi.fn(),
  offPush: vi.fn(),
  offMcp: vi.fn(),
  list: vi.fn(async () => ({ agentKind: 'pi', servers: [] })),
}));
vi.mock('../botPronounContext', () => ({ useBotTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botStore', () => ({
  getEffectiveBotModelChain: () => [],
  subscribeBotGlobalModel: () => () => {},
}));
vi.mock('@/lib/sessionService', () => ({ get: async () => ({ agentKind: 'pi' }) }));
vi.mock('@/lib/sessionsBus', () => ({ onPatch: () => h.offLocal }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
import { BotCapabilitySettings } from '../BotCapabilitySettings';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('controlled capability page lifetime', () => {
  it('unsubscribes when hidden and loads afresh when reopened', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        localDb: { sessionsPush: { onPatched: () => h.offPush } },
        maker: {
          onMcpChanged: () => h.offMcp,
          listCustomMcpServers: h.list,
          listAgentSkills: async () => ({ success: true, skills: [] }),
          plugins: { list: async () => [] },
        },
      },
    });
    const bot = { id: 'bot-1', canonicalSessionId: 's1' } as BotProfile;
    const capabilities = {
      modelChain: [],
      modelChainOverride: null,
      mcpServers: [],
      toolsets: [],
    } as unknown as BotProfile['capabilities'];
    const props = { bot, capabilities, skills: [], onChange: vi.fn() };
    const view = render(<BotCapabilitySettings {...props} expanded />);
    await waitFor(() => expect(h.list).toHaveBeenCalledOnce());
    view.rerender(<BotCapabilitySettings {...props} expanded={false} />);
    expect(h.offLocal).toHaveBeenCalledOnce();
    expect(h.offPush).toHaveBeenCalledOnce();
    expect(h.offMcp).toHaveBeenCalledOnce();
    expect(view.getByTestId('bot-capability-editor').hasAttribute('open')).toBe(false);
    view.rerender(<BotCapabilitySettings {...props} expanded />);
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  });
});
