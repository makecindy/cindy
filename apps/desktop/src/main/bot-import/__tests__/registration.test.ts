import { beforeAll, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ start: vi.fn(), sources: vi.fn(), preview: vi.fn(), status: vi.fn(), handlers: new Map<string, (event: unknown, operation: unknown, input?: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (event: unknown, operation: unknown, input?: unknown) => Promise<unknown>) => h.handlers.set(name, fn) } }));
vi.mock('../host.js', () => ({ startCompanionImport: h.start, listCompanionImportSources: h.sources, previewCompanionImport: h.preview, getCompanionImportResult: h.status }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => ({ controllerDeviceId: 'phone', channel: 'maker:remote-resources:invoke' }) }));
import { registerCompanionImport } from '../registration.js';
import { registerRemoteResourcesIpc } from '../../device-link/remoteResourcesIpc.js';
import { CompanionImportError } from '../types.js';
import { extractIpcError } from '../../../shared/ipcError.js';
import { COMPANION_IMPORT_ERROR_CODES } from '../../../shared/ipc-errors.js';
beforeAll(() => { registerCompanionImport(); registerRemoteResourcesIpc(); });
it.each([
  ['sources', 'SOURCE_CONFIG_INVALID'], ['preview', 'PREVIEW_EXPIRED'],
  ['start', 'INVALID_SELECTION'], ['status', 'OWNER_CHANGED'],
] as const)('decodes %s failures after Electron drops custom Error fields', async (operation, code) => {
  h[operation].mockRejectedValueOnce(new CompanionImportError(code));
  const error = await h.handlers.get('companion-import')!({ sender: { id: 1 } }, operation, 'fixture').catch(error => error);
  if (!(error instanceof Error)) throw new Error('Expected IPC rejection');
  expect(error).toMatchObject({ code });
  const serialized = new Error(`Error invoking remote method 'companion-import': Error: ${error.message}`);
  expect(extractIpcError(serialized)).toEqual({ code, message: code });
});
it('encodes invalid operations and hides unexpected local failures', async () => {
  await expect(h.handlers.get('companion-import')!({ sender: { id: 1 } }, 'unknown')).rejects.toThrow('[INVALID_REQUEST] INVALID_REQUEST');
  h.start.mockRejectedValueOnce(new Error('fixture private filesystem path'));
  await expect(h.handlers.get('companion-import')!({ sender: { id: 1 } }, 'start', {})).rejects.toThrow('[IMPORT_FAILED] IMPORT_FAILED');
  h.start.mockRejectedValueOnce(new CompanionImportError('fixture unknown private failure'));
  await expect(h.handlers.get('companion-import')!({ sender: { id: 1 } }, 'start', {})).rejects.toThrow('[IMPORT_FAILED] IMPORT_FAILED');
});
it.each(COMPANION_IMPORT_ERROR_CODES)('preserves the typed %s code through the local handler and decoder', async code => {
  h.start.mockRejectedValueOnce(new CompanionImportError(code));
  const error = await h.handlers.get('companion-import')!({ sender: { id: 1 } }, 'start', {}).catch(error => error);
  if (!(error instanceof Error)) throw new Error('Expected IPC rejection');
  expect(extractIpcError(new Error(error.message))?.code).toBe(code);
});
const invoke = () => h.handlers.get('maker:remote-resources:invoke')!({}, { collectionId: 'companion-import', resourceRef: { collectionId: 'companion-import', kind: 'import', id: 'preview:source' }, actionId: 'import', input: {}, client: { protocolVersion: 1, primitives: ['companion-import'] } });
it.each(['IMPORT_NAME_EXISTS', 'INVALID_SELECTION', 'PROFILE_TEXT_TOO_LARGE', 'SOURCE_SNAPSHOT_TOO_LARGE', 'SOURCE_TOO_MANY_FILES'])('preserves %s through the actual remote provider and IPC boundary', async code => {
  h.start.mockRejectedValueOnce(new CompanionImportError(code));
  await expect(invoke()).rejects.toThrow(`[INVALID_PARAMS] ${code}`);
});
it('continues to hide unexpected provider failures from mobile', async () => {
  h.start.mockRejectedValueOnce(new Error('fixture private filesystem path'));
  await expect(invoke()).rejects.toThrow('[INTERNAL] remote resource provider failed');
});
