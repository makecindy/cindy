import { describe, expect, it } from 'vitest';
import { companionCapabilitiesPatch, parseCompanionCapabilities, portableCompanionCapabilities } from '../capabilities.js';

const route = (model: string, extra: Record<string, unknown> = {}) =>
  ({ harness: 'claude' as const, model, providerId: 'p1', effort: 'high', fastMode: false, ...extra });

describe('portable companion capabilities', () => {
  it('carries references and switches, never the permission level, credentials or the invitation state', () => {
    const value = portableCompanionCapabilities({
      permissions: 'trusted', invitation: { id: 'x' }, userContextSource: 'private', apiKey: 'sk-1',
      skills: ['a', 'a', 'b'], skillMode: 'allowlist', skillsExcluded: ['old'],
      toolsets: ['plugin-x'], toolsetMode: 'inherit', mcpServers: ['mcp-1'], mcpMode: 'allowlist',
      memory: false, inputHandoff: true, allowSchedulerFollow: true, gender: 'female',
    }, null);
    expect(value).toEqual({ skills: ['a', 'b'], skillMode: 'allowlist', skillsExcluded: ['old'], toolsets: ['plugin-x'],
      toolsetMode: 'inherit', mcpServers: ['mcp-1'], mcpMode: 'allowlist', memory: false, inputHandoff: true, allowSchedulerFollow: true, gender: 'female' });
  });

  it('carries the names of the referenced MCP servers (this computer\'s win, an earlier computer\'s are kept), nothing else about them', () => {
    const config = { mcpServers: ['mcp-1', 'mcp-2', 'mcp-3'], mcpServerNames: { 'mcp-2': 'Old name', 'mcp-3': 'From before', stray: 'x' } };
    const value = portableCompanionCapabilities(config, null, { 'mcp-1': 'Docs', 'mcp-2': 'New name', other: 'y' });
    expect(value.mcpServerNames).toEqual({ 'mcp-1': 'Docs', 'mcp-2': 'New name', 'mcp-3': 'From before' });
    // Read back from the cloud defensively, and handed to the profile for display.
    expect(parseCompanionCapabilities({ mcpServers: ['a'], mcpServerNames: { a: ' Wiki ', b: 'unreferenced', c: 3 } })?.mcpServerNames).toEqual({ a: 'Wiki' });
    expect(parseCompanionCapabilities({ mcpServers: ['a'] })).toEqual({ mcpServers: ['a'] });
    expect(companionCapabilitiesPatch({ mcpServers: ['a'], mcpServerNames: { a: 'Wiki' } }, { chain: [], task: null })).toMatchObject({ mcpServers: ['a'], mcpServerNames: { a: 'Wiki' } });
  });

  it('carries only the model chain the owner chose, without routes that run on another computer', () => {
    const chosen = [route('m1'), route('m2', { agentDeviceId: 'phone-1' })];
    expect(portableCompanionCapabilities({}, chosen).modelChain).toEqual([route('m1')]);
    // Following the default is not a choice to carry: the new computer follows its own default.
    expect(portableCompanionCapabilities({}, null)).toEqual({});
    expect(portableCompanionCapabilities({ taskModelOverride: route('t1') }, null).taskModel).toEqual(route('t1'));
    expect(portableCompanionCapabilities({ taskModelOverride: route('t1', { agentDeviceId: 'x' }) }, null).taskModel).toBeUndefined();
    expect(portableCompanionCapabilities({ taskModelOverride: 'garbage' }, null).taskModel).toBeUndefined();
  });

  it('reads a cloud value defensively', () => {
    expect(parseCompanionCapabilities(null)).toBeNull();
    expect(parseCompanionCapabilities([])).toBeNull();
    expect(parseCompanionCapabilities({ skills: ['a', 3, ''], skillMode: 'bogus', memory: 'yes', permissions: 'trusted',
      modelChain: [route('m1'), { nope: true }, route('m2', { agentDeviceId: 'x' })], taskModel: { model: '' } }))
      .toEqual({ skills: ['a'], modelChain: [route('m1')] });
  });
});

describe('companionCapabilitiesPatch', () => {
  it('keeps references this computer lacks, and carries the usable model chain as the explicit choice', () => {
    const patch = companionCapabilitiesPatch({ skills: ['missing-here'], mcpServers: ['mcp-1'], mcpMode: 'allowlist', memory: false,
      modelChain: [route('m1'), route('m2')] }, { chain: [route('m2')], task: null });
    expect(patch).toMatchObject({ skills: ['missing-here'], mcpServers: ['mcp-1'], mcpMode: 'allowlist', memory: false,
      model: 'm2', modelChain: [route('m2')], modelChainOverride: [route('m2')] });
    expect(patch).not.toHaveProperty('permissions');
  });

  it('follows this computer\'s default model when none of the saved routes is usable', () => {
    expect(companionCapabilitiesPatch({ modelChain: [route('m1')] }, { chain: [], task: null }))
      .toEqual({ modelOverride: null, modelChainOverride: null, taskModelOverride: null });
    expect(companionCapabilitiesPatch({ taskModel: route('t1') }, { chain: [], task: null })).toMatchObject({ taskModelOverride: null });
    expect(companionCapabilitiesPatch({ taskModel: route('t1') }, { chain: [], task: route('t1') })).toMatchObject({ taskModelOverride: route('t1') });
  });

  it('clears the model and task-model choices a copy kept from an earlier stay when the cloud value names none', () => {
    // The main computer follows its default (or cleared its task model): a stale local override must not survive.
    expect(companionCapabilitiesPatch({ memory: true }, { chain: [], task: null }))
      .toEqual({ memory: true, modelOverride: null, modelChainOverride: null, taskModelOverride: null });
    expect(companionCapabilitiesPatch({ modelChain: [route('m1')] }, { chain: [route('m1')], task: null }))
      .toMatchObject({ modelChainOverride: [route('m1')], taskModelOverride: null });
  });
});
