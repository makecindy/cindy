import type { ProjectWorkspace } from '../../../../shared/projectWorkspaceSettings';
import type { ProjectNode } from './projectGrouping';

export function groupWorkspaceProjects(
  projects: readonly ProjectNode[],
  workspaces: readonly ProjectWorkspace[],
  comparisonKey: (key: string) => string,
) {
  const membership = new Map<string, string>();
  const groups = workspaces.map((workspace) => {
    for (const key of workspace.projectKeys) {
      if (!membership.has(comparisonKey(key))) membership.set(comparisonKey(key), workspace.id);
    }
    return { workspace, projects: [] as ProjectNode[] };
  });
  const byId = new Map(groups.map((group) => [group.workspace.id, group]));
  const ungrouped: ProjectNode[] = [];
  for (const project of projects) {
    const workspaceId = membership.get(comparisonKey(project.projectKey));
    const group = workspaceId ? byId.get(workspaceId) : undefined;
    if (group) group.projects.push(project);
    else ungrouped.push(project);
  }
  return { groups, ungrouped };
}

export function mergeWorkspaceOrder(
  workspaces: readonly ProjectWorkspace[],
  visibleOrder: readonly string[],
): string[] {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const order = [...new Set(visibleOrder)].filter((id) => known.has(id));
  const reordered = new Set(order);
  let cursor = 0;
  return workspaces.map((workspace) =>
    reordered.has(workspace.id) ? order[cursor++]! : workspace.id,
  );
}
