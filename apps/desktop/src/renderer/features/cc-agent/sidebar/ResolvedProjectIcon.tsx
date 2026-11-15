import { projectAliasComparisonKey, resolveProjectIcon } from '@cindy/maker-shared/project-alias-sync';
import { useProjectInfo } from '../hooks/useProjectInfo';
import { ProjectIcon } from './ProjectIcon';

/** Resolve identity on the computer that owns the directory, including SSH hosts. */
export function ResolvedProjectIcon({ directory, remoteHostId, deviceId, name, size = 20 }: {
  directory: string;
  remoteHostId?: string | null;
  deviceId?: string | null;
  name?: string;
  size?: number;
}) {
  const info = useProjectInfo(deviceId ?? null);
  const projectKey = remoteHostId ? `remote:${encodeURIComponent(remoteHostId)}:${directory}` : `local:${directory}`;
  const key = info && projectAliasComparisonKey(projectKey, info.platform);
  const alias = info?.aliases.find(row => projectAliasComparisonKey(row.projectKey, info.platform) === key)?.alias;
  const projectName = alias || name || directory.replace(/\\/g, '/').split('/').filter(Boolean).pop() || directory;
  return <ProjectIcon value={resolveProjectIcon(info, projectKey)} projectKey={projectKey}
    projectName={projectName} deviceId={deviceId}
    automaticEnabled={(info?.settingsVersion ?? 0) >= 4} size={size} />;
}
