import type { DataOwnerPushStamp } from './dataOwnerPush.js';

export interface ProjectWorkspace {
  id: string;
  name: string;
  projectKeys: string[];
  collapsed: boolean;
}

export interface ProjectWorkspaceSnapshot {
  workspaces: ProjectWorkspace[];
  ownerStamp?: DataOwnerPushStamp;
}

export const PROJECT_WORKSPACES_GET_CHANNEL = 'sidebar-settings:get-project-workspaces';
export const PROJECT_WORKSPACES_MUTATE_CHANNEL = 'sidebar-settings:mutate-project-workspaces';
export const PROJECT_WORKSPACES_CHANGED_CHANNEL = 'sidebar-settings:project-workspaces-changed';

export type ProjectWorkspaceMutation =
  | { type: 'create'; id: string; name: string; projectKey?: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'reorder'; workspaceIds: string[] }
  | { type: 'move-project'; projectKey: string; workspaceId: string | null }
  | { type: 'set-collapsed'; id: string; collapsed: boolean };

export interface ProjectWorkspaceMutationRequest {
  ownerStamp: DataOwnerPushStamp;
  mutation: ProjectWorkspaceMutation;
}
