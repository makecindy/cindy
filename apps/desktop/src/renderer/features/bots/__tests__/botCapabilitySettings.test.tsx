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
vi.mock('../botPronounContext', () => ({ useBotTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }) }));
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
    const checkbox = view.getByRole('switch', { name: '整理工作周报' }) as HTMLButtonElement;
    expect(checkbox.getAttribute('aria-checked') === 'true').toBe(true);
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
  const checkbox = (name: string) => view.getByRole('switch', { name }) as HTMLButtonElement;
  expect(checkbox('Documents').getAttribute('aria-checked') === 'true').toBe(true);
  expect(checkbox('Orca').getAttribute('aria-checked') === 'true').toBe(true);
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
  const saved = () => view.getByRole('switch', { name: /saved/ }) as HTMLInputElement;
  expect(saved().disabled).toBe(true);
  await waitFor(() => expect(view.getByRole('button', { name: 'bots.retry' })).toBeTruthy());
  expect(saved().getAttribute('aria-checked') === 'true').toBe(true);
  expect(saved().disabled).toBe(true);
  fireEvent.click(saved());
  expect(onChange).not.toHaveBeenCalled();

  recovered = true;
  fireEvent.click(view.getByRole('button', { name: 'bots.retry' }));
  await waitFor(() => expect(view.getByText('Other inherited capability')).toBeTruthy());
  const loaded = view.getByRole('switch', { name: 'Saved capability' }) as HTMLInputElement;
  expect(loaded.disabled).toBe(false);
  expect((view.getByRole('switch', { name: 'Other inherited capability' }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
  fireEvent.click(loaded);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(kind, ['inherited']);
});

it('keeps the full tool list visible and offers configuration for available and unavailable tools', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
    maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list,
      listAgentSkills: async () => ({ success: true, skills: [] }),
      plugins: { list: async () => [
        { id: 'browser', name: 'Browser', description: 'Read and operate web pages', available: true },
        { id: 'computer', name: 'Computer', description: 'Use local apps', available: false },
      ] },
    },
  } });
  const onConfigure = vi.fn();
  const view = render(<BotCapabilitySettings expanded onConfigure={onConfigure}
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null, mcpServers: [], toolsets: [],
      toolsetMode: 'inherit', mcpMode: 'inherit' } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={vi.fn()} />);
  await waitFor(() => expect(view.getByRole('switch', { name: 'Browser' })).toBeTruthy());
  const field = view.getByRole('switch', { name: 'Browser' }).closest('fieldset')!;
  expect(field.querySelector('.overflow-y-auto')).toBeNull();
  expect(field.textContent).toContain('Read and operate web pages');
  const buttons = field.querySelectorAll<HTMLButtonElement>('button:not([role=switch])');
  fireEvent.click(buttons[0]!); expect(onConfigure).toHaveBeenLastCalledWith('toolset', 'browser');
  fireEvent.click(buttons[1]!); expect(onConfigure).toHaveBeenLastCalledWith('toolset', 'computer');
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'web pages' } });
  expect(view.getByRole('switch', { name: 'Browser' })).toBeTruthy();
  expect(view.queryByRole('switch', { name: 'Computer' })).toBeNull();
});
