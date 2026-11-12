/**
 * Worker-side line diffing for large Edit/MultiEdit payloads.
 * The worker imports only the pure analysis function; it has no Electron,
 * filesystem, or renderer privileges.
 */

import { computeDiffDetails, type ToolDiffDetails, type ToolDiffSegmentInput } from './diffStats';

type DiffWorkerRequest = { id: string; segments: ToolDiffSegmentInput[] };

self.addEventListener('message', (event: MessageEvent<DiffWorkerRequest>) => {
  const request = event.data;
  if (!request?.id || !Array.isArray(request.segments)) return;
  try {
    const segments = request.segments.map((segment) => ({
      key: segment.key,
      details: computeDiffDetails(segment.oldString, segment.newString),
    }));
    const result: ToolDiffDetails = {
      stats: segments.reduce(
        (total, segment) => ({
          add: total.add + segment.details.stats.add,
          del: total.del + segment.details.stats.del,
        }),
        { add: 0, del: 0 },
      ),
      segments,
      truncated: segments.some((segment) => segment.details.truncated === true),
    };
    (self as unknown as Worker).postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
