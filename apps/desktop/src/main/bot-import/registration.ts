import { ipcMain } from 'electron';
import { COMPANION_IMPORT_CHUNK_PRIMITIVE, type CompanionImportSelection, type CompanionImportSubmission } from '@cindy/maker-shared/companion-import';
import { remoteResourceRegistry, RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult, readRemoteCompanionImport, submitRemoteCompanionImport } from './host.js';
import { CompanionImportError } from './types.js';
import { isIpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** The same host service serves local UI, device-link and command callers. */
export function registerCompanionImport(): void {
  ipcMain.handle('companion-import', async (event, operation: unknown, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const controller = `renderer:${event.sender.id}`;
    try {
      if (operation === 'sources') return await listCompanionImportSources(controller);
      if (operation === 'preview' && typeof input === 'string') return await previewCompanionImport(input, controller);
      if (operation === 'start') return await startCompanionImport(input as CompanionImportSelection, controller);
      if (operation === 'status' && typeof input === 'string') return await getCompanionImportResult(input);
      throw new CompanionImportError('INVALID_REQUEST');
    } catch (error) {
      const code = error instanceof CompanionImportError && isIpcErrorCode(error.code) ? error.code : 'IMPORT_FAILED';
      throwIpcError(code, code);
    }
  });
  remoteResourceRegistry.register({
    collection: { id: 'companion-import', resourceKind: 'import', title: 'Import', placement: 'hidden', icon: { name: 'import', fallbackText: '↓' } },
    async list() { return { collectionId: 'companion-import', revision: '1', items: [] }; },
    async get(context, request) {
      try {
        const id = request.ref.id;
        const data = await readRemoteCompanionImport(id, context.controllerDeviceId,
          request.client.primitives.includes(COMPANION_IMPORT_CHUNK_PRIMITIVE));
        return { ref: request.ref, revision: '1', display: { title: 'Import' }, links: [],
          blocks: [{ id: 'import', primitive: 'companion-import', fallbackMarkdown: 'Hermes / OpenClaw', data }],
          actions: id.startsWith('preview:') ? [{ id: 'import', label: 'Import' }] : [] };
      } catch (error) {
        const code = error instanceof CompanionImportError ? error.code : 'IMPORT_FAILED';
        throw new RemoteResourceRegistryError(code === 'IMPORT_CLIENT_UPGRADE_REQUIRED' ? 'UNSUPPORTED_CAPABILITY' : 'NOT_FOUND', code);
      }
    },
    async invoke(context, request) {
      try {
        if (request.actionId !== 'import' || !request.resourceRef?.id.startsWith('preview:')) throw new CompanionImportError('INVALID_REQUEST');
        const result = await submitRemoteCompanionImport(request.input as unknown as CompanionImportSubmission, context.controllerDeviceId);
        if (!result) return { effects: [] };
        return { effects: [{ kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'companion-import', kind: 'import', id: `result:${result.requestId}` } } }] };
      } catch (error) {
        // Stable host rejections must survive the IPC boundary so the phone can
        // unlock its preflight form. Unexpected failures remain redacted.
        throw new RemoteResourceRegistryError(error instanceof CompanionImportError ? 'INVALID_PARAMS' : 'INTERNAL', error instanceof CompanionImportError ? error.code : 'IMPORT_FAILED');
      }
    },
  });
}
