// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileMakerTransport, RemoteDirectoryListResult } from '@/device-link/mobileMakerTransport';
import { useOrcaWorkerDirectoryPicker } from '@/session/useOrcaWorkerDirectoryPicker';

let root: Root;
let picker: ReturnType<typeof useOrcaWorkerDirectoryPicker>;
const choose = vi.fn();
const sheet = vi.fn();
const result = (path: string): RemoteDirectoryListResult => ({
  resolvedPath: path, parent: 'D:\\', entries: [
    { name: 'project', path: `${path}/project`, kind: 'dir' },
    { name: '.hidden', path: `${path}/.hidden`, kind: 'dir' },
    { name: 'file.txt', path: `${path}/file.txt`, kind: 'file' },
  ], drives: [{ name: 'C:', path: 'C:\\', current: false }, { name: 'D:', path: 'D:\\', current: true }],
});
const maker = (listDir = vi.fn(async () => result('D:\\projects'))) => ({ fs: { listDir } }) as unknown as MobileMakerTransport;
function Probe({ source, device = 'B', scope = 'account', epoch = 1 }: {
  source: MobileMakerTransport; device?: string; scope?: string; epoch?: number;
}) {
  picker = useOrcaWorkerDirectoryPicker({ maker: source, deviceId: device, scope, formEpoch: epoch,
    workingDir: '', onChoose: choose, setSheetOpen: sheet });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  choose.mockReset(); sheet.mockReset(); root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

it('reads the selected execution host, filters files/hidden folders, and returns after full dismissal', async () => {
  const target = maker();
  await act(async () => root.render(<Probe source={target} />));
  act(() => picker.openPicker());
  expect(sheet).toHaveBeenLastCalledWith(false);
  expect(picker.page).toBe('workspace');
  await act(async () => { picker.browse(); await flush(); });
  expect(target.fs.listDir).toHaveBeenCalledWith('~');
  expect(picker.path).toBe('D:\\projects');
  expect(picker.entries.map(entry => entry.name)).toEqual(['project']);
  expect(picker.drives.map(drive => drive.name)).toEqual(['C:', 'D:']);
  act(() => picker.setShowHidden(true));
  expect(picker.entries.map(entry => entry.name)).toEqual(['project', '.hidden']);
  act(() => picker.choose(picker.path));
  expect(choose).toHaveBeenCalledWith('D:\\projects');
  expect(picker.page).toBeNull();
  expect(sheet).toHaveBeenLastCalledWith(false);
  act(() => picker.closed());
  expect(sheet).toHaveBeenLastCalledWith(true);
});

it.each(['device', 'scope', 'epoch'] as const)('discards a late response and form return after %s changes', async (change) => {
  let resolve!: (value: RemoteDirectoryListResult) => void;
  const target = maker(vi.fn(() => new Promise<RemoteDirectoryListResult>(done => { resolve = done; })));
  await act(async () => root.render(<Probe source={target} />));
  act(() => picker.openPicker());
  act(() => picker.browse());
  await act(async () => root.render(<Probe source={target} device={change === 'device' ? 'C' : 'B'}
    scope={change === 'scope' ? 'other-account' : 'account'} epoch={change === 'epoch' ? 2 : 1} />));
  await act(async () => { resolve(result('D:\\old-host')); await flush(); });
  expect(picker.page).toBeNull();
  expect(picker.path).toBe('');
  act(() => { picker.choose('D:\\old-host'); picker.closed(); });
  expect(choose).not.toHaveBeenCalled();
  expect(sheet).toHaveBeenLastCalledWith(false);
});

it('cancels without changing the folder and ignores an earlier read after reopening', async () => {
  let resolve!: (value: RemoteDirectoryListResult) => void;
  const list = vi.fn(async () => result('D:\\new'));
  list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const target = maker(list);
  await act(async () => root.render(<Probe source={target} />));
  act(() => { picker.openPicker(); picker.browse(); });
  act(() => { picker.close(); picker.closed(); });
  expect(choose).not.toHaveBeenCalled();
  await act(async () => { picker.openPicker(); picker.browse(); await flush(); });
  await act(async () => { resolve(result('D:\\old')); await flush(); });
  expect(picker.path).toBe('D:\\new');
  act(() => picker.choose(null));
  expect(choose).toHaveBeenCalledWith(null);
});

it('keeps a valid folder usable when the optional Windows drive retry fails', async () => {
  const list = vi.fn(async () => result('D:\\projects'));
  list.mockResolvedValueOnce({ ...result('D:\\projects'), drivesPending: true, drives: [] });
  list.mockRejectedValueOnce(new Error('drive enumeration interrupted'));
  await act(async () => root.render(<Probe source={maker(list)} />));
  await act(async () => { picker.openPicker(); picker.browse(); await flush(); });
  expect(picker.path).toBe('D:\\projects');
  expect(picker.error).toBeNull();
  expect(picker.loading).toBe(false);
});
