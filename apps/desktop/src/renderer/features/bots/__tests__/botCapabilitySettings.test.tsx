// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
        localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [{ slug: 'weekly-report', name: '整理工作周报', enabled: true }] } },
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
    await waitFor(() => expect(view.getByText('整理工作周报')).toBeTruthy());
    const checkbox = view.getByText('整理工作周报').closest('label')!.querySelector('input')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    view.rerender(<BotCapabilitySettings {...props} expanded={false} />);
    expect(h.offLocal).toHaveBeenCalledOnce();
    expect(h.offPush).toHaveBeenCalledOnce();
    expect(h.offMcp).toHaveBeenCalledOnce();
    expect(view.getByTestId('bot-capability-editor').hasAttribute('open')).toBe(false);
    view.rerender(<BotCapabilitySettings {...props} expanded />);
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  });
});


it('shows inherited tools as selected and preserves the others when one is explicitly removed', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
    maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list,
      listAgentSkills: async () => ({ success: true, skills: [] }),
      plugins: { list: async () => [
        { id: 'docs', name: 'Documents', available: true },
        { id: 'collab', name: 'Orca', available: true },
      ] },
    },
  } });
  const onChange = vi.fn();
  const view = render(<BotCapabilitySettings expanded
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null, mcpServers: [], toolsets: [],
      toolsetMode: 'inherit', mcpMode: 'inherit' } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={onChange} />);
  await waitFor(() => expect(view.getByText('Documents')).toBeTruthy());
  const checkbox = (name: string) => view.getByText(name).closest('label')!.querySelector('input')!;
  expect(checkbox('Documents').checked).toBe(true);
  expect(checkbox('Orca').checked).toBe(true);
  fireEvent.click(checkbox('Documents'));
  expect(onChange).toHaveBeenCalledWith('toolset', ['collab']);
});

it.each(['mcp', 'toolset'] as const)('preserves inherited %s tools until its failed catalog is retried', async (kind) => {
  let recovered = false;
  const entries = [
    { id: 'saved', name: 'Saved capability', available: true },
    { id: 'inherited', name: 'Other inherited capability', available: true },
  ];
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
    maker: {
      onMcpChanged: () => h.offMcp,
      listCustomMcpServers: async () => {
        if (kind === 'mcp' && !recovered) throw new Error('MCP catalog unavailable');
        return { agentKind: 'pi', servers: kind === 'mcp' ? entries : [] };
      },
      listAgentSkills: async () => ({ success: true, skills: [] }),
      plugins: { list: async () => {
        if (kind === 'toolset' && !recovered) throw new Error('Tool catalog unavailable');
        return kind === 'toolset' ? entries : [];
      } },
    },
  } });
  const onChange = vi.fn();
  const view = render(<BotCapabilitySettings expanded
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null,
      mcpServers: kind === 'mcp' ? ['saved'] : [], toolsets: kind === 'toolset' ? ['saved'] : [],
      toolsetMode: 'inherit', mcpMode: 'inherit' } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={onChange} />);
  const saved = () => view.getByRole('checkbox', { name: /saved/ }) as HTMLInputElement;
  expect(saved().disabled).toBe(true);
  await waitFor(() => expect(view.getByRole('button', { name: 'bots.retry' })).toBeTruthy());
  expect(saved().checked).toBe(true);
  expect(saved().disabled).toBe(true);
  fireEvent.click(saved());
  expect(onChange).not.toHaveBeenCalled();

  recovered = true;
  fireEvent.click(view.getByRole('button', { name: 'bots.retry' }));
  await waitFor(() => expect(view.getByText('Other inherited capability')).toBeTruthy());
  const loaded = view.getByRole('checkbox', { name: 'Saved capability' }) as HTMLInputElement;
  expect(loaded.disabled).toBe(false);
  expect((view.getByRole('checkbox', { name: 'Other inherited capability' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(loaded);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(kind, ['inherited']);
});
