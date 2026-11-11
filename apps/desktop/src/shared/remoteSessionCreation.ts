import { z } from 'zod';

/** Only ordinary creation options cross this boundary: no role, parent, Bot or callback routing. */
export const remoteSessionCreationSchema = z.object({
  title: z.string().max(500).optional(),
  projectDir: z.string().trim().min(1).max(4096).nullable().optional(),
  workingDir: z.string().trim().min(1).max(4096).optional(),
  useWorktree: z.boolean().optional(),
  agentKind: z.enum(['claude-code', 'codex', 'pi']).optional(),
  model: z.string().min(1).max(512).optional(),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  fast: z.union([z.boolean(), z.literal('ultrafast')]).optional(),
  agentDeviceId: z.string().trim().min(1).max(128).nullable().optional(),
  permissionMode: z.enum(['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
}).strict();
export type RemoteSessionCreation = z.infer<typeof remoteSessionCreationSchema>;

/** Bind the source authorization to the complete creation request, not just its message. */
export function creationOperation(input: RemoteSessionCreation): string {
  const parsed = remoteSessionCreationSchema.parse(input);
  return `create:${JSON.stringify(parsed)}`;
}

export interface RemoteSessionCreated {
  targetSessionId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  targetTitle: string | null;
  projectDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  workingDir: string;
  worktreePath: string | null;
  model: string;
  providerId: string | null;
  effort: RemoteSessionCreation['effort'] | null;
  fastMode: boolean | 'ultrafast';
}
