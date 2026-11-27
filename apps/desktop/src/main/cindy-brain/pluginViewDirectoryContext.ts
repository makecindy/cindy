import path from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import {
  PLUGIN_VIEW_DIRECTORY_CONTEXT,
  SET_PLUGIN_VIEW_DIRECTORY_CONTEXT,
  type PluginViewDirectoryContext,
} from '../../shared/pluginViewDirectoryContext.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { workingDirectoryRecovery } from '../maker-ipc/workingDirectoryRecovery.desktop.js';
import { statWorkingDirectory } from '../workdir-probe-host/index.js';
import { isTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

type DirectoryRow = Pick<NonNullable<Awaited<ReturnType<typeof getSessionRowSnapshot>>>,
  'workingDir' | 'projectDir' | 'remoteHostId'>;

interface ResolvedDirectoryContext {
  context: PluginViewDirectoryContext;
  originalWorkingDir?: string;
}

function absoluteDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32768 || value.includes('\0') ||
    !path.isAbsolute(value) || (process.platform === 'win32' && !path.parse(value).root.includes(':') &&
      !value.startsWith('\\\\'))) return null;
  return value;
}

/** Project drafts already know their selected folder. Saved tasks use the local DB's directory facts. */
async function resolvePluginViewDirectoryContext(
  source: unknown,
  readTask: (id: string) => Promise<DirectoryRow | null>,
): Promise<ResolvedDirectoryContext | null> {
  if (!source || typeof source !== 'object') return null;
  if ('kind' in source && source.kind === 'project' && 'projectDir' in source) {
    const projectDir = absoluteDirectory(source.projectDir);
    return projectDir ? { context: { projectDir, workingDir: null } } : null;
  }
  if (!('kind' in source) || source.kind !== 'task' || !('sessionId' in source) ||
    typeof source.sessionId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(source.sessionId)) return null;
  const row = await readTask(source.sessionId);
  if (!row || row.remoteHostId) return null;
  const originalWorkingDir = absoluteDirectory(row.workingDir);
  if (!originalWorkingDir) return null;
  const workingDir = workingDirectoryRecovery.resolve(source.sessionId, originalWorkingDir);
  const projectDir = absoluteDirectory(row.projectDir);
  return { context: { projectDir, workingDir }, originalWorkingDir };
}

interface DirectoryGuest {
  host: WebContents;
  deliver(source: unknown): Promise<void>;
}

const guests = new Map<number, DirectoryGuest>();

/** Called only for an approved package entry by the existing plugin guest attach gate. */
export function bindPluginViewDirectoryGuest(
  host: WebContents,
  guest: WebContents,
  entryUrl: string,
  isCurrent: () => boolean,
  isDisabled: (dir: string) => boolean,
): void {
  const guestId = guest.id;
  let generation = 0;
  let entryDocument = false;
  const invalidateDocument = () => {
    entryDocument = false;
    generation++;
  };
  guest.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) invalidateDocument();
  });
  // Only a committed top-level entry can receive paths. In-page routing
  // can change the address without replacing that approved document.
  guest.on('did-navigate', (_event, url) => {
    generation++;
    entryDocument = url === entryUrl;
  });
  guest.on('render-process-gone', invalidateDocument);
  guest.once('destroyed', () => guests.delete(guestId));
  guests.set(guestId, {
    host,
    async deliver(source) {
      const requested = ++generation;
      if (!entryDocument || guest.isDestroyed() || !isCurrent()) return;
      const frame = guest.mainFrame;
      const current = () => requested === generation && !guest.isDestroyed() && isCurrent() &&
        guest.mainFrame === frame;
      const resolved = await resolvePluginViewDirectoryContext(source, getSessionRowSnapshot);
      if (!current()) return;
      if (!resolved) {
        frame.send(PLUGIN_VIEW_DIRECTORY_CONTEXT, null);
        return;
      }
      const { context, originalWorkingDir } = resolved;
      const dirs = new Set([context.workingDir, context.projectDir, originalWorkingDir]);
      const disabled = () => [...dirs].some(dir => dir && isDisabled(dir));
      const currentDir = context.workingDir ?? context.projectDir;
      const available = currentDir && !disabled() &&
        await statWorkingDirectory(currentDir).then(stat => stat.isDirectory(), () => false);
      if (current()) frame.send(PLUGIN_VIEW_DIRECTORY_CONTEXT, available && !disabled() ? context : null);
    },
  });
}

export function registerPluginViewDirectoryContextIpc(): void {
  ipcMain.handle(SET_PLUGIN_VIEW_DIRECTORY_CONTEXT, async (event, guestId: unknown, source: unknown) => {
    if (getDeviceLinkInvokeContext() || !isTrustedAppRendererEvent(event) || typeof guestId !== 'number') return;
    const binding = guests.get(guestId);
    if (binding?.host === event.sender) await binding.deliver(source);
  });
}
