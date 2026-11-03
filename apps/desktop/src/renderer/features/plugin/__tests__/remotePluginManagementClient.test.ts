import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePluginManagementProjectState,
  parsePluginManagementProject,
  parsePluginManagementSnapshot,
  readLegacyManagedPlugin,
  readLegacyManagedPlugins,
} from '../remotePluginManagementClient';

const snapshot = {
  version: 1,
  ghosts: [],
  market: { items: [], customSourceNames: [], unavailableCustomSourceNames: [] },
};
describe('remote project response boundaries', () => {
  it('requires an explicit fixed-share installation capability from the selected Host', () => {
    expect(parsePluginManagementSnapshot(snapshot).localShares).toBeUndefined();
    expect(parsePluginManagementSnapshot({ ...snapshot, localShares: true }).localShares).toBe(true);
    expect(() => parsePluginManagementSnapshot({ ...snapshot, localShares: 'true' })).toThrow('INVALID_RESPONSE');
  });
  it('distinguishes old Host capability absence from a supported empty project catalogue', () => {
    expect(parsePluginManagementSnapshot(snapshot).projects).toBeUndefined();
    expect(parsePluginManagementSnapshot({ ...snapshot, projects: [] }).projects).toEqual([]);
  });
  it('accepts optional target display paths and an explicit browser capability while rejecting malformed declarations', () => {
    const project = { id: 'b', name: 'Cindy', path: 'D:\\Projects\\Cindy' };
    expect(parsePluginManagementProject(project)).toEqual(project);
    expect(parsePluginManagementSnapshot({ ...snapshot, projects: [project], projectBrowse: true }).projectBrowse).toBe(true);
    for (const path of [42, '', 'bad\0path', 'x'.repeat(32769)]) {
      expect(() => parsePluginManagementProject({ ...project, path })).toThrow('INVALID_RESPONSE');
      expect(() => parsePluginManagementSnapshot({ ...snapshot, projects: [{ ...project, path }] })).toThrow('INVALID_RESPONSE');
    }
    expect(() => parsePluginManagementSnapshot({ ...snapshot, projectBrowse: 'yes' })).toThrow('INVALID_RESPONSE');
  });
  it.each<unknown[]>([
    [
      { id: 'a', name: 'Cindy' },
      { id: 'a', name: 'Other' },
    ],
    [{ id: '', name: 'Cindy' }],
    [{ id: 'a', name: null }],
  ])('rejects ambiguous or malformed Host project declarations', (projects) => {
    expect(() => parsePluginManagementSnapshot({ ...snapshot, projects })).toThrow(
      'INVALID_RESPONSE',
    );
  });
  it('binds project state to the requested identity and a valid revision before enabling any writes', () => {
    const state = { projectId: 'a', revision: 'a'.repeat(64), disabled: ['_ns__team__notes'] };
    expect(parsePluginManagementProjectState(state, 'a')).toEqual(state);
    expect(() => parsePluginManagementProjectState(state, 'b')).toThrow('INVALID_RESPONSE');
    expect(() => parsePluginManagementProjectState({ ...state, revision: 'stale' }, 'a')).toThrow(
      'INVALID_RESPONSE',
    );
    expect(() => parsePluginManagementProjectState({ ...state, disabled: [true] }, 'a')).toThrow(
      'INVALID_RESPONSE',
    );
  });
});

describe('older Host plugin presentation', () => {
  afterEach(() => vi.unstubAllGlobals());
  const item = {
    ref: { collectionId: 'plugins', kind: 'plugin', id: '_ns__team__notes' },
    revision: 'r1',
    display: {
      title: { fallback: 'Notes', translations: { 'zh-CN': '笔记' } },
      subtitle: 'Read and organize notes',
      avatar: { kind: 'asset', value: 'data:image/png;base64,aWNvbg==', fallbackText: 'N' },
      status: { label: 'disabled' },
    },
    actions: [{ id: 'enable', label: 'Enable' }],
  };
  function host(response: unknown) {
    const invoke = vi.fn(async () => response);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    return invoke;
  }
  it('keeps the selected Host instance, icon, localized name and actual enable state', async () => {
    const invoke = host({ items: [item] });
    const rows = await readLegacyManagedPlugins('old-host', 'zh-CN');
    expect(rows).toEqual([
      {
        id: '_ns__team__notes',
        name: '笔记',
        description: 'Read and organize notes',
        iconDataUrl: item.display.avatar.value,
        enabled: false,
      },
    ]);
    expect(invoke.mock.calls[0]).toMatchObject([
      'old-host',
      expect.any(String),
      [{ client: { locale: 'zh-CN' } }],
    ]);
  });
  it('reads structured detail facts instead of discarding everything except fallback text', async () => {
    const facts = {
      tools: [{ name: 'read_notes', description: 'Read saved notes' }],
      permissions: [{ title: 'Read notes', description: 'Only the declared notes service' }],
      details: [{ key: 'author', title: 'Author', value: 'Example Team' }],
    };
    const invoke = host({
      ...item,
      blocks: [
        { id: 'about', primitive: 'markdown', fallbackMarkdown: 'Full plugin description' },
        { id: 'version', primitive: 'status', fallbackMarkdown: '1.2.3' },
        { id: 'capabilities', primitive: 'plugin-capabilities', fallbackMarkdown: '', data: facts },
      ],
    });
    expect(await readLegacyManagedPlugin('old-host', item.ref.id, 'zh-CN')).toEqual({
      id: item.ref.id,
      name: '笔记',
      description: 'Full plugin description',
      iconDataUrl: item.display.avatar.value,
      enabled: false,
      version: '1.2.3',
      ...facts,
    });
    expect(invoke.mock.calls[0]).toMatchObject([
      'old-host',
      expect.any(String),
      [
        {
          client: { locale: 'zh-CN', primitives: expect.arrayContaining(['plugin-capabilities']) },
        },
      ],
    ]);
  });
  it('leaves absent metadata and enable status unknown rather than fabricating facts', async () => {
    host({ ...item, display: { title: 'Notes' }, actions: [], blocks: [] });
    const detail = await readLegacyManagedPlugin('old-host', item.ref.id);
    expect(detail).toMatchObject({ name: 'Notes', id: item.ref.id });
    expect(detail.enabled).toBeUndefined();
    expect(detail.version).toBeUndefined();
    expect(detail.details).toBeUndefined();
    expect(detail.permissions).toBeUndefined();
    expect(detail.tools).toBeUndefined();
  });
  it('rejects another resource kind or collection with the same id', async () => {
    host({ ...item, ref: { ...item.ref, collectionId: 'bots' }, blocks: [] });
    await expect(readLegacyManagedPlugin('old-host', item.ref.id)).rejects.toThrow(
      'INVALID_RESPONSE',
    );
  });
  it('ignores invalid optional detail groups without losing the readable plugin', async () => {
    host({
      ...item,
      blocks: [
        {
          id: 'capabilities',
          primitive: 'plugin-capabilities',
          fallbackMarkdown: '',
          data: {
            tools: [{ name: 1 }],
            permissions: [{ title: null }],
            details: [{ key: 'author', value: [] }],
          },
        },
      ],
    });
    const detail = await readLegacyManagedPlugin('old-host', item.ref.id);
    expect(detail.name).toBe('Notes');
    expect(detail.tools).toBeUndefined();
    expect(detail.permissions).toBeUndefined();
    expect(detail.details).toBeUndefined();
  });
  it('keeps readable fields when an optional action list has an invalid shape', async () => {
    host({ items: [{ ...item, actions: {}, display: { title: 'Notes' } }] });
    expect(await readLegacyManagedPlugins('old-host')).toEqual([
      { id: item.ref.id, name: 'Notes', description: '' },
    ]);
  });
});
