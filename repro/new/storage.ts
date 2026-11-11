export const SSH_SCOPE_KEY_PREFIX = 'ssh:';
export function buildMemoryScopeKey(dir: string, host: string): string { return 'ssh:' + host + ':' + dir; }
