// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileReadResult } from '@cindy/file-browser-core';
import { i18n, i18nReady } from '@/i18n';

import { FilePathHeader } from '../FilePathHeader';
import { useFileContent } from '../hooks/useFileContent';

// Test value (#10763 discussion_r4581911149, engineering §8.3): the real header,
// reader, transport and shared cache must keep a file visible without another
// host read after src/a.ts -> root AGENTS.md -> src/a.ts. Existing fileMeta/state
// tests never mount the header or exercise this cleanup. Unit tier: only the host
// boundary is faked; SSH and device-link use their production renderer routes.
interface ReadRequest {
  workdir: string;
  relPath: string;
  remoteHostId?: string | null;
}
interface ReadSuccess {
  ok: true;
  data: FileReadResult;
}
interface FileViewProps {
  workdir: string;
  relPath: string;
  remoteHostId?: string | null;
  deviceId?: string | null;
}

// Mirrors the production route's body reader alongside its path header.
function FileView(props: FileViewProps) {
  const { content } = useFileContent(props.workdir, props.relPath, props.remoteHostId, props.deviceId);
  return <>
    <FilePathHeader {...props} />
    <output>{content.kind === 'text' ? content.content : content.kind}</output>
  </>;
}

function fileResult(owner: string, relPath: string, template = true): ReadSuccess {
  const content = relPath === '.cindy/template.json'
    ? JSON.stringify({ version: 5, files: template ? { 'AGENTS.md': 'a'.repeat(64) } : {} })
    : `${owner}: ${relPath}`;
  return { ok: true as const, data: { relPath, content, size: content.length, mtimeMs: 1, truncated: false } };
}

function localRead(request: ReadRequest) {
  return Promise.resolve(fileResult(request.remoteHostId ? `ssh:${request.remoteHostId}` : 'local', request.relPath));
}
function deviceRead(deviceId: string, channel: string, [request]: [ReadRequest & { op: string }]) {
  if (channel !== 'file-browser:remote-op' || request.op !== 'readFile') {
    throw new Error(`Unexpected device operation: ${channel}/${request.op}`);
  }
  return Promise.resolve(fileResult(`dev:${deviceId}`, request.relPath));
}
const readFile = vi.fn(localRead);
const invoke = vi.fn(deviceRead);
function readPaths() {
  return [
    ...readFile.mock.calls.map(([request]) => request.relPath),
    ...invoke.mock.calls.map(([, , [request]]) => request.relPath),
  ];
}

beforeEach(async () => {
  await i18nReady;
  readFile.mockReset().mockImplementation(localRead);
  invoke.mockReset().mockImplementation(deviceRead);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      fileBrowser: {
        readFile,
        cachePut: vi.fn(async () => undefined),
        onEvent: () => () => {},
      },
      deviceLink: { invoke, onRemotePush: () => () => {} },
    },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

const endpoints = [
  { name: 'local', owner: 'local', remoteHostId: null, deviceId: null },
  { name: 'SSH', owner: 'ssh:host-a', remoteHostId: 'host-a', deviceId: null },
  { name: 'device-link', owner: 'dev:device-a', remoteHostId: null, deviceId: 'device-a' },
];

describe('FilePathHeader metadata lifetime', () => {
  it.each(endpoints)('keeps body content cached across rule selection on $name', async endpoint => {
    // A logical workdir shared by the host fakes, not a native filesystem path.
    const props = { workdir: '/repo', relPath: 'src/a.ts', remoteHostId: endpoint.remoteHostId, deviceId: endpoint.deviceId };
    const view = render(<FileView {...props} />);
    await screen.findByText(`${endpoint.owner}: src/a.ts`);
    expect(readPaths()).toEqual(['src/a.ts']); // The non-rule header must not read metadata.

    view.rerender(<FileView {...props} relPath="AGENTS.md" />);
    await screen.findByText(`${endpoint.owner}: AGENTS.md`);
    await screen.findByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'));
    view.rerender(<FileView {...props} />);
    expect(screen.getByRole('status').textContent).toBe(`${endpoint.owner}: src/a.ts`);
    expect(screen.queryByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'))).toBeNull();
    expect(readPaths().filter(path => path === 'src/a.ts')).toHaveLength(1);

    view.rerender(<FileView {...props} relPath="AGENTS.md" />);
    expect(screen.getByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'))).toBeTruthy();
    expect(readPaths().filter(path => path === '.cindy/template.json')).toHaveLength(1);
    if (endpoint.deviceId) expect(readFile).not.toHaveBeenCalled();
    else expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'SSH hosts', from: { remoteHostId: 'host-a' }, to: { remoteHostId: 'host-b' }, owner: 'ssh:host-b' },
    { name: 'devices', from: { deviceId: 'device-a' }, to: { deviceId: 'device-b' }, owner: 'dev:device-b' },
  ])('does not reuse another endpoint body or provenance across $name', async endpoint => {
    const props = { workdir: '/repo', relPath: 'AGENTS.md' };
    const view = render(<FileView {...props} {...endpoint.from} />);
    await screen.findByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'));
    // Endpoint B deliberately has no template record for AGENTS.md.
    if ('deviceId' in endpoint.to) {
      invoke.mockImplementation(async (id, channel, [request]) => {
        await deviceRead(id, channel, [request]);
        return fileResult(`dev:${id}`, request.relPath, `dev:${id}` !== endpoint.owner);
      });
    } else {
      readFile.mockImplementation(async request =>
        fileResult(`ssh:${request.remoteHostId}`, request.relPath, `ssh:${request.remoteHostId}` !== endpoint.owner));
    }
    await act(async () => { view.rerender(<FileView {...props} {...endpoint.to} />); });
    expect(screen.getByRole('status').textContent).toBe(`${endpoint.owner}: AGENTS.md`);
    expect(screen.queryByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'))).toBeNull();
    expect(readPaths().filter(path => path === 'AGENTS.md')).toHaveLength(2);
    expect(readPaths().filter(path => path === '.cindy/template.json')).toHaveLength(2);
  });

  it('discards a canceled device metadata read instead of caching its late provenance', async () => {
    const record = Promise.withResolvers<ReadSuccess>();
    invoke.mockImplementation((id, channel, [request]) => request.relPath === '.cindy/template.json'
      ? record.promise : deviceRead(id, channel, [request]));
    const props = { workdir: '/repo', relPath: 'AGENTS.md', deviceId: 'device-a' };
    const view = render(<FileView {...props} />);
    await screen.findByText('dev:device-a: AGENTS.md');
    view.rerender(<FileView {...props} relPath="src/a.ts" />);
    await screen.findByText('dev:device-a: src/a.ts');
    await act(async () => { record.resolve(fileResult('dev:device-a', '.cindy/template.json')); });
    expect(screen.queryByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'))).toBeNull();

    invoke.mockImplementation(async (id, _channel, [request]) => fileResult(`dev:${id}`, request.relPath, false));
    await act(async () => { view.rerender(<FileView {...props} />); });
    expect(screen.getByRole('status').textContent).toBe('dev:device-a: AGENTS.md');
    expect(screen.queryByText(i18n.t('ccAgent.workdirBrowse.fileBody.templateRules'))).toBeNull();
    expect(readPaths().filter(path => path === '.cindy/template.json')).toHaveLength(2);
  });
});
