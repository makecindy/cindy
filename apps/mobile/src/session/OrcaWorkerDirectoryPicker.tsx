import { useRemoteSessions } from './remoteSessionStore';
import { buildRecentWorkspaceOptions } from './newSession';
import { NewTaskSelectionSheet } from './NewTaskSelectionSheet';
import type { useOrcaWorkerDirectoryPicker } from './useOrcaWorkerDirectoryPicker';

/** Reuse the new-task workspace presentation, scoped to the Worker's execution device. */
export function OrcaWorkerDirectoryPicker({ picker, deviceId, workingDir, mode }: {
  picker: ReturnType<typeof useOrcaWorkerDirectoryPicker>;
  deviceId?: string;
  workingDir?: string;
  mode?: string;
}) {
  const sessions = useRemoteSessions();
  const workspaces = buildRecentWorkspaceOptions(
    sessions.filter(session => session.deviceLinkDeviceId === deviceId), deviceId ?? '',
  );
  return <NewTaskSelectionSheet
    page={picker.page} busy={false} devices={[]} selectedDeviceId={deviceId ?? ''}
    workspaces={workspaces} workspaceKind={mode === 'path' ? 'project' : 'dialogue'} workingDir={workingDir ?? ''}
    path={picker.path} parent={picker.parent} entries={picker.entries} drives={picker.drives}
    loading={picker.loading} error={picker.error} showHidden={picker.showHidden}
    onClose={picker.close} onClosed={picker.closed} onBack={picker.back} onDevice={() => undefined}
    onDialogue={() => picker.choose(null)} onProject={picker.choose} onBrowse={picker.browse}
    onEnter={path => void picker.load(path)} onChoose={picker.choose} onShowHidden={picker.setShowHidden}
  />;
}
