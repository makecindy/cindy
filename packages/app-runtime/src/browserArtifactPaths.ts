import path from 'node:path';


export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'session').slice(0, 64);
}


export function processArtifactRoot(rootDir: string): string {
  return path.join(rootDir, `process-${process.pid}`);
}


export function artifactSessionRoot(rootDir: string, sessionId: string): string {
  return path.join(processArtifactRoot(rootDir), safeSegment(sessionId));
}