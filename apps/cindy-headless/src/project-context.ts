import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './profile.js';

export interface ProjectContextSnapshot {
  injected: boolean;
  reason?: 'disabled' | 'no-toc-file' | 'empty-toc-file';
  content?: string;
  tocPath: string;
  digest: string | null;
}

export async function readProjectContext(workingDir: string, enabled: boolean): Promise<ProjectContextSnapshot> {
  const tocPath = path.join(path.resolve(workingDir), '.cindy', 'project-knowledge', 'TOC.md');
  if (!enabled) return { injected: false, reason: 'disabled', tocPath, digest: null };
  let raw: string;
  try {
    raw = await readFile(tocPath, 'utf8');
  } catch {
    return { injected: false, reason: 'no-toc-file', tocPath, digest: null };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { injected: false, reason: 'empty-toc-file', tocPath, digest: sha256(raw) };
  return { injected: true, content: `<project-context-toc>\n${trimmed}\n</project-context-toc>`, tocPath, digest: sha256(raw) };
}
