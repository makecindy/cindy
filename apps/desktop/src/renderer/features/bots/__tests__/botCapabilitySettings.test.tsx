// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile } from '../botStore';

const h = vi.hoisted(() => ({
  offLocal: vi.fn(),
  offPush: vi.fn(),
  offMcp: vi.fn(),
  list: vi.fn(async () => ({ agentKind: 'pi', servers: [] })),
  setEnabled: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
  skillPage: null as null | { view: { type: string; editing?: boolean }; onView: (view: unknown) => void;
    editorDirtyRef?: { current: (() => boolean) | null } },
}));
vi.mock('../botPronounContext', () => ({ useBotTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }) }));
vi.mock('../botStore', () => ({
  getEffectiveBotModelChain: () => [],
  subscribeBotGlobalModel: () => () => {},
}));
vi.mock('@/lib/sessionService', () => ({ get: async () => ({ agentKind: 'pi' }) }));
// The Skill pages render Markdown; these tests cover the list.
vi.mock('../BotSkillPage', () => ({ BotSkillPage: (props: NonNullable<typeof h.skillPage>) => { h.skillPage = props; return null; } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: vi.fn() } }));
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
        localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: {
          listSkills: async () => [{ slug: 'weekly-report', name: '整理工作周报', enabled: true }],
          skills: { setEnabled: h.setEnabled },
        } },
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
    // A learned Skill can be turned off from the list; the files stay.
    fireEvent.click(checkbox);
    await waitFor(() => expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith('bot-1', 'weekly-report', false));
    view.rerender(<BotCapabilitySettings {...props} expanded={false} />);
    expect(h.offLocal).toHaveBeenCalledOnce();
    expect(h.offPush).toHaveBeenCalledOnce();
    expect(h.offMcp).toHaveBeenCalledOnce();
    expect(view.getByTestId('bot-capability-editor').hasAttribute('open')).toBe(false);
    view.rerender(<BotCapabilitySettings {...props} expanded />);
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  });
});

it('shows the name, not the internal id, of a kept reference this computer does not have', async () => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
      maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list, listAgentSkills: async () => ({ success: true, skills: [] }), plugins: { list: async () => [] } },
    },
  });
  const bot = { id: 'bot-1', canonicalSessionId: 's1' } as BotProfile;
  const capabilities = { modelChain: [], modelChainOverride: null, mcpMode: 'allowlist', mcpServers: ['mcp_9f3a', 'mcp_unnamed'],
    mcpServerNames: { mcp_9f3a: '公司知识库' }, toolsets: [] } as unknown as BotProfile['capabilities'];
  const view = render(<BotCapabilitySettings bot={bot} capabilities={capabilities} skills={[]} onChange={vi.fn()} expanded />);
  expect(await view.findByText('公司知识库')).toBeTruthy();
  expect(view.queryByText('mcp_9f3a')).toBeNull();
  expect(view.getByText('mcp_unnamed')).toBeTruthy();
  expect(view.getAllByText('bots.capabilities.notOnThisComputer')).toHaveLength(2);
});

it.each([
  { enabled: true, runtimeStatus: 'discovered', firstEnabled: false, firstStatus: 'discovered' },
  { enabled: false, runtimeStatus: 'discovered', firstEnabled: true, firstStatus: 'discovered' },
  { enabled: true, runtimeStatus: 'discovered', firstEnabled: true, firstStatus: 'failed' },
  { enabled: true, runtimeStatus: 'failed', firstEnabled: true, firstStatus: 'discovered' },
])('uses the runtime winner for duplicate skill state: $enabled/$runtimeStatus', async ({ enabled, runtimeStatus, firstEnabled, firstStatus }) => {
  const discovered = [
    { name: 'agent-ops', path: '/home/.agents/skills/agent-ops/SKILL.md', scope: 'repo',
      description: 'First source description', enabled: firstEnabled, runtimeStatus: firstStatus },
    { name: 'agent-ops', path: '/home/.agents/skills/agent-ops/SKILL.md', scope: 'user',
      description: 'Runtime winner description', enabled, runtimeStatus },
    { name: 'unique-skill', path: '/project/.pi/skills/unique-skill/SKILL.md', enabled: true },
  ];
  const listAgentSkills = vi.fn(async () => ({ success: true, skills: discovered }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
    maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list,
      listAgentSkills, plugins: { list: async () => [] } },
  } });
  const onChange = vi.fn();
  const view = render(<BotCapabilitySettings expanded
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null, mcpServers: [], toolsets: [] } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={onChange} />);

  await waitFor(() => expect(view.getAllByRole('switch', { name: 'agent-ops' })).toHaveLength(1));
  const checkbox = view.getByRole('switch', { name: 'agent-ops' }) as HTMLButtonElement;
  const available = enabled && runtimeStatus !== 'failed';
  expect(checkbox.disabled).toBe(!available);
  expect(view.getByText('Runtime winner description')).toBeTruthy();
  expect(view.queryByText('First source description')).toBeNull();
  expect(view.getByRole('switch', { name: 'unique-skill' })).toBeTruthy();
  if (available) {
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('skill', ['agent-ops']);
  }
  // Rendering must leave the discovery catalog intact for other consumers.
  expect(discovered).toHaveLength(3);
  expect(listAgentSkills).toHaveBeenCalledOnce();
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

it('offers turning on an unavailable tool and keeps tool settings in the group heading', async () => {
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
  expect(field.textContent).toContain('Read and operate web pages');
  fireEvent.click(view.getByRole('button', { name: 'bots.capabilities.turnOn' }));
  expect(onConfigure).toHaveBeenLastCalledWith('toolset', 'computer');
  fireEvent.click(view.getByRole('button', { name: 'bots.capabilities.toolSettings' }));
  expect(onConfigure).toHaveBeenLastCalledWith('toolset');
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'web pages' } });
  expect(view.getByRole('switch', { name: 'Browser' })).toBeTruthy();
  expect(view.queryByRole('switch', { name: 'Computer' })).toBeNull();
});

it('turns a system Skill off for this teammate without touching shared references', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: { listSkills: async () => [] } },
    maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list,
      listAgentSkills: async () => ({ success: true, skills: [] }), plugins: { list: async () => [] } },
  } });
  const onChange = vi.fn();
  const onSystemSkillChange = vi.fn();
  const view = render(<BotCapabilitySettings expanded onSystemSkillChange={onSystemSkillChange}
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null, mcpServers: [], toolsets: [],
      systemSkillsOff: ['routine'] } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={onChange} />);
  const todo = view.getByRole('switch', { name: 'bots.capabilities.system.items.todo.name' });
  const routine = view.getByRole('switch', { name: 'bots.capabilities.system.items.routine.name' });
  expect(todo.getAttribute('aria-checked')).toBe('true');
  expect(routine.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(todo);
  expect(onSystemSkillChange).toHaveBeenCalledExactlyOnceWith('todo', false);
  expect(onChange).not.toHaveBeenCalled();
});

// Greptile #8330: back and closing settings must not silently drop an edited learned Skill.
it('asks before leaving a learned Skill editor with unsaved changes', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessionsPush: { onPatched: () => h.offPush }, bots: {
      listSkills: async () => [{ slug: 'weekly-report', name: '整理工作周报', enabled: true }],
      skills: { setEnabled: h.setEnabled, read: vi.fn() },
    } },
    maker: { onMcpChanged: () => h.offMcp, listCustomMcpServers: h.list,
      listAgentSkills: async () => ({ success: true, skills: [] }), plugins: { list: async () => [] } },
  } });
  const backRef: { current: (() => Promise<boolean>) | null } = { current: null };
  const leaveRef: { current: (() => Promise<boolean>) | null } = { current: null };
  const view = render(<BotCapabilitySettings expanded backRef={backRef} leaveRef={leaveRef}
    bot={{ id: 'bot-1', canonicalSessionId: 's1' } as BotProfile}
    capabilities={{ modelChain: [], modelChainOverride: null, mcpServers: [], toolsets: [] } as unknown as BotProfile['capabilities']}
    skills={[]} onChange={vi.fn()} />);
  fireEvent.click(await view.findByText('整理工作周报'));
  await waitFor(() => expect(h.skillPage?.view).toEqual({ type: 'learned', slug: 'weekly-report' }));
  expect(leaveRef.current).toBeNull();
  h.skillPage!.onView({ type: 'learned', slug: 'weekly-report', editing: true });
  await waitFor(() => expect(leaveRef.current).not.toBeNull());
  h.skillPage!.editorDirtyRef!.current = () => true;
  h.confirm.mockResolvedValueOnce(false);
  expect(await backRef.current!()).toBe(true);
  expect(h.skillPage?.view.editing).toBe(true);
  h.confirm.mockResolvedValueOnce(false);
  expect(await leaveRef.current!()).toBe(false);
  expect(await backRef.current!()).toBe(true);
  await waitFor(() => expect(h.skillPage?.view.editing).toBe(false));
  expect(h.confirm).toHaveBeenCalledTimes(3);
});
