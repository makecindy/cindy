import { readImageAnnotations } from '../../shared/imageAnnotations.js';

type ProjectHistoryRow = { role: string; content: unknown; agentMeta?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function visibleContent(row: ProjectHistoryRow, localCopy: boolean) {
  const content = row.content;
  if (typeof content === 'string') return content.trim() ? content : null;
  const object = record(content);
  const blocks = Array.isArray(content) ? content : [];
  const text = typeof object?.text === 'string' ? object.text : blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  if (row.role === 'user') {
    // Persist only the pointers used by the user's attachment chips. Never copy wire bytes or internal context.
    const files = (Array.isArray(object?.files) ? object.files : blocks.filter(block => block?.type === 'file'))
      .filter(file => typeof file?.path === 'string')
      .map(file => ({ path: file.path, name: file.name ?? file.originalName }));
    const images = (Array.isArray(object?.images) ? object.images : blocks.filter(block => block?.type === 'image'))
      .filter(image => typeof image?.url === 'string' && !image.url.startsWith('data:'))
      .map(image => ({ url: image.url, mimeType: image.mimeType, originalName: image.originalName,
        ...(localCopy ? readImageAnnotations(image) : {}),
      }));
    if (files.length || images.length) return { text, files, images };
  }
  return text.trim() ? text : null;
}

/** Only the visible conversation and its display author cross a companion identity boundary. */
export function projectCompanionHandoffHistory<T extends ProjectHistoryRow>(rows: T[], mode: 'visible' | 'local-copy' = 'visible') {
  return rows.flatMap(row => {
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    let value = row.agentMeta;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return []; }
    }
    const meta = record(value);
    if (meta?.parentUuid || meta?.botPrivateReply || meta?.autoResume || meta?.failedSamplingAttempt
      || meta?.samplingAttemptPending || meta?.contextRebuild || meta?.voiceCall || meta?.sessionImport) return [];
    const content = visibleContent(row, mode === 'local-copy');
    if (!content) return [];
    const author = record(meta?.projectCompanion);
    const agentMeta = author && typeof author.displayName === 'string'
      ? { projectCompanion: { displayName: author.displayName, botId: author.botId,
        profileVersion: author.profileVersion, revision: author.revision } } : null;
    return [{ ...row, content, agentMeta }];
  });
}
