import { projectAliasComparisonKey, resolveProjectIcon } from '@cindy/maker-shared/project-alias-sync';
import { ProjectIcon } from './ProjectIcon';
import { useRemoteProjectAliases } from './remoteProjectAliases';

/** Workspace paths are local to the selected computer, never to the phone. */
export function ProjectPickerIcon({ deviceId, workingDir, title, remoteHostId, size = 24 }: {
  deviceId: string; workingDir: string; title?: string; remoteHostId?: string | null; size?: number;
}) {
  const info = useRemoteProjectAliases().get(deviceId);
  const projectKey = remoteHostId ? `remote:${encodeURIComponent(remoteHostId)}:${workingDir}` : `local:${workingDir}`;
  const key = info && projectAliasComparisonKey(projectKey, info.platform);
  const alias = info?.aliases.find(row => projectAliasComparisonKey(row.projectKey, info.platform) === key)?.alias;
  const name = alias || title || workingDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || workingDir;
  return <ProjectIcon value={resolveProjectIcon(info, projectKey)} projectKey={projectKey}
    projectName={name} deviceId={deviceId}
    automaticEnabled={(info?.settingsVersion ?? 0) >= 4} size={size} />;
}
