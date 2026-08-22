export const BOT_WORKSPACE_POLICIES = ['none', 'reuse', 'per-task', 'read-only'] as const;
export type BotWorkspacePolicy = (typeof BOT_WORKSPACE_POLICIES)[number];

export interface BotProjectBindingView {
  id: string;
  projectKey: string;
  workingDir: string;
  remoteHostId?: string;
  defaultBranch?: string;
  workspacePolicy: BotWorkspacePolicy;
  isDefault: boolean;
  allowedPaths: string[];
  status: 'active' | 'paused' | 'error' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface BotWorkspaceLeaseView {
  id: string;
  projectBindingId: string;
  leaseKey: string;
  anchorSessionId?: string;
  worktreePath?: string;
  baseRepo: string;
  branch?: string;
  sourceBranch?: string;
  remoteHostId?: string;
  generation: number;
  status: 'acquiring' | 'active' | 'releasing' | 'released' | 'error';
  lastHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  releasedAt?: number;
}
