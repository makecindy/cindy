import { BrowserWindow, dialog } from 'electron';

import {
  PiManagedPackageMutationCancelledError,
  type PiManagedPackageMutationRequest,
} from '@cindy/maker-core';

import type {
  PiPackageMutationRequest,
  PiPackageMutationResult,
} from '../../shared/piPackages.js';
import { t } from '../i18n.js';
import {
  issuePiPackageMutationGrant,
  type PiPackageMutationGrant,
} from './pi-package-mutation-grant.js';
import { escapePiPackageNativeDialogText } from './pi-package-native-dialog.js';
import { mutatePiPackage } from './pi-package-store.js';

type ManagedMutationRequest = Pick<PiPackageMutationRequest, 'action' | 'source'>;

export interface PiManagedPackageMutationDeps {
  confirmLocalMutation(request: ManagedMutationRequest): Promise<boolean>;
  issueGrant(request: ManagedMutationRequest): PiPackageMutationGrant;
  mutate(
    request: ManagedMutationRequest,
    grant: PiPackageMutationGrant,
  ): Promise<PiPackageMutationResult>;
}

export async function confirmLocalPiManagedPackageMutation(
  request: ManagedMutationRequest,
): Promise<boolean> {
  const source = escapePiPackageNativeDialogText(request.source);
  const copy = request.action === 'remove'
    ? {
        title: t('settings.piPackages.uninstallTitle'),
        message: t('settings.piPackages.uninstallDescription').replace('{{name}}', source),
        confirm: t('settings.piPackages.confirmUninstall'),
      }
    : request.action === 'update'
      ? {
          title: t('settings.piPackages.updateConfirmTitle'),
          message: t('settings.piPackages.updateConfirmDescription').replace('{{source}}', source),
          confirm: t('settings.piPackages.confirmUpdate'),
        }
      : {
          title: t('settings.piPackages.confirmTitle'),
          message: t('settings.piPackages.confirmDescription').replace('{{source}}', source),
          confirm: t('settings.piPackages.confirmInstall'),
        };
  const options = {
    type: 'warning' as const,
    title: copy.title,
    message: copy.title,
    detail: copy.message,
    buttons: [copy.confirm, t('settings.piPackages.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const owner = BrowserWindow.getFocusedWindow();
  const decision = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return decision.response === 0;
}

const defaultDeps: PiManagedPackageMutationDeps = {
  confirmLocalMutation: confirmLocalPiManagedPackageMutation,
  issueGrant: issuePiPackageMutationGrant,
  mutate: mutatePiPackage,
};

export async function mutateAuthorizedPiManagedPackage(
  request: PiManagedPackageMutationRequest,
  deps: PiManagedPackageMutationDeps = defaultDeps,
): Promise<PiPackageMutationResult> {
  const storeRequest = {
    action: request.action,
    source: request.source,
  } as const;

  if (request.authorization === 'local-desktop-command') {
    const confirmed = await deps.confirmLocalMutation(storeRequest);
    if (!confirmed) throw new PiManagedPackageMutationCancelledError();
  } else if (
    request.authorization !== 'authenticated-im-command'
    && request.authorization !== 'confirmed-tool-call'
  ) {
    throw new Error('Pi extension mutation is missing host-trusted authorization');
  }

  return deps.mutate(storeRequest, deps.issueGrant(storeRequest));
}
