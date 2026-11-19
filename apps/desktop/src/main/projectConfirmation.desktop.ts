import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { t } from './i18n.desktop.js';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from './appSessionState.js';
import {
  projectRendererAuthorization,
  type ProjectConfirmation,
} from './projectInfoAuthorization.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { requireObject, throwIpcError } from './utils/ipcValidate.js';

/** Show complete values on distinct lines; control characters must not forge another field. */
function display(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
  );
}

export async function confirmProjectAction(
  event: IpcMainInvokeEvent,
  request: ProjectConfirmation,
  signal?: AbortSignal,
): Promise<void> {
  assertTrustedAppRendererEvent(event);
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed())
    throwIpcError('PRECONDITION_FAILED', 'Project window closed');
  const repo = request.kind === 'repository';
  const text = (key: string) => t(`projectSettings.${key}`);
  const detail =
    request.kind === 'repository'
      ? [
          text('credentialNotice'),
          text('repository') + '\n' + display(request.url),
          text('saveTo') + '\n' + display(request.directory),
        ]
      : [
          text('sshHost') + '\n' + display(request.host),
          text('mainDirectory') + '\n' + display(request.project),
          ...request.directories.map(
            (d) =>
              text(d.access === 'write' ? 'readWriteAccess' : 'readAccess') +
              '\n' +
              display(d.path),
          ),
        ];
  const { response } = await dialog.showMessageBox(parent, {
    signal,
    type: 'question',
    message: text(repo ? 'confirmImportTitle' : 'confirmSshTitle'),
    detail: detail.join('\n\n'),
    buttons: [text('cancel'), text(repo ? 'confirmImport' : 'confirmAccess')],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  assertTrustedAppRendererEvent(event);
  if (response !== 1) throwIpcError('MUTATION_CANCELLED', 'Project action cancelled');
}

export function rendererProjectRequest(
  event: IpcMainInvokeEvent,
  input: unknown,
  readOwner = getActiveDataOwnerPushStamp,
) {
  assertTrustedAppRendererEvent(event);
  const owner = readOwner();
  const body = requireObject(input, 'project');
  return projectRendererAuthorization(
    event.sender.id,
    body.projectGrantScope,
    owner,
    (intent, signal) => confirmProjectAction(event, intent, signal),
    () => {
      assertTrustedAppRendererEvent(event);
      const current = readOwner();
      if (
        isAppSessionBoundaryPending() ||
        !owner.dataOwnerId ||
        current.dataOwnerId !== owner.dataOwnerId ||
        current.ownerGeneration !== owner.ownerGeneration ||
        body.dataOwnerId !== owner.dataOwnerId ||
        body.ownerGeneration !== owner.ownerGeneration
      )
        throwIpcError('PRECONDITION_FAILED', 'Project account changed');
    },
  );
}
