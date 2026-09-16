import path from 'node:path';

/**
 * Host-owned authorization for a local filesystem path that resolved outside
 * the current session workingDir. Cindy Desktop registers this once; other
 * hosts may leave it unset, in which case the path stays fail-closed.
 */
export type SessionPathAuthorizationRequest = {
  sessionId?: string;
  sessionInstanceId?: string;
  workingDir: string;
  remoteHostId?: string;
  path: string;
  toolName: string;
  operation: 'read' | 'write';
};

export type SessionPathAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type SessionPathAuthorizer = (
  request: SessionPathAuthorizationRequest,
) => Promise<SessionPathAuthorization>;

let authorizer: SessionPathAuthorizer | undefined;

export function setSessionPathAuthorizer(next?: SessionPathAuthorizer): void {
  authorizer = next;
}

export function getSessionPathAuthorizer(): SessionPathAuthorizer | undefined {
  return authorizer;
}

export function resolveAbsoluteSessionPath(root: string, inputPath: string): string {
  const rootAbs = path.resolve(root);
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootAbs, inputPath);
}

export async function authorizeSessionPathOutsideWorkdir(
  request: SessionPathAuthorizationRequest,
): Promise<SessionPathAuthorization> {
  if (request.remoteHostId) {
    return {
      allowed: false,
      reason: '远程会话不能授权控制端本机路径。请改用当前任务工作目录内的路径，或在本机会话中重试。',
    };
  }
  const fn = authorizer;
  if (!fn) {
    return {
      allowed: false,
      reason: `路径 "${request.path}" 不在本任务的工作目录内。请改用工作目录内的相对路径。`,
    };
  }
  return fn(request);
}
