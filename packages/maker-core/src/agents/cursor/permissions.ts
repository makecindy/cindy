import type { ReviewableAction } from '../shared/auto-review.js';
import { cursorToolInput } from './translator.js';
import { record, type AcpRecord } from './models.js';

/** Review only concrete native input; a display title is not command/path evidence. */
export function cursorReviewAction(tool: AcpRecord, workingDir: string): ReviewableAction {
  const input = cursorToolInput(tool);
  const text = (...keys: string[]) => keys.map(key => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const locations = Array.isArray(tool.locations) ? tool.locations.map(record) : [];
  const target = text('path', 'filePath', 'file_path', 'target_file', 'targetPath', 'absolutePath')
    ?? (locations.length === 1 && typeof locations[0].path === 'string' ? locations[0].path : undefined);
  switch (tool.kind) {
    case 'execute':
      return { kind: 'exec', command: text('command', 'cmd') ?? '',
        cwd: text('cwd', 'workingDirectory') ?? workingDir,
        ...(('cwd' in input || 'workingDirectory' in input) && !text('cwd', 'workingDirectory')
          ? { cwdUnknown: true } : {}) };
    case 'read':
    case 'search':
      // Missing or multiple targets cannot be silently classified as a safe read.
      if (target && locations.length <= 1) return { kind: 'read', path: target, ...(tool.kind === 'search' ? { scope: 'tree' as const } : {}) };
      break;
    case 'edit':
    case 'delete':
      // ACP provides lexical locations, not execution-time canonical write roots.
      if (target && locations.length <= 1 && tool.kind === 'edit') return { kind: 'file-write', path: target,
        resolvedPath: null, resolvedWritableRoots: null };
      break;
    case 'fetch':
      return { kind: 'network', target: text('url', 'uri', 'query'), operation: text('method') };
  }
  return { kind: 'other', description: JSON.stringify({ kind: tool.kind, input,
    ...(locations.length ? { locations } : {}) }) };
}
