// Experiment only: reconstruct the measured candidate without changing production source.
import assert from "node:assert/strict";

const SERIAL_LOOP = `    for (let index = 0; index < chunks; index += 1) {
      requireOpen();
      const data = gz.subarray(index * REMOTE_AGENT_UPLOAD_CHUNK_BYTES, (index + 1) * REMOTE_AGENT_UPLOAD_CHUNK_BYTES);
      await this.invoke([{ op: 'upload', uploadId, index, data: data.toString('base64') }]);
      // An in-flight chunk can finish after cancellation, but no next chunk or open may start.
      requireOpen();
    }
`;
const WINDOW_LOOP = `    for (let base = 0; base < chunks; base += UPLOAD_WINDOW) {
      requireOpen();
      const pending = Array.from({ length: Math.min(UPLOAD_WINDOW, chunks - base) }, async (_, offset) => {
        requireOpen();
        const index = base + offset;
        const data = gz.subarray(index * REMOTE_AGENT_UPLOAD_CHUNK_BYTES, (index + 1) * REMOTE_AGENT_UPLOAD_CHUNK_BYTES);
        await this.invoke([{ op: 'upload', uploadId, index, data: data.toString('base64') }]);
      });
      // Drain this bounded batch even on failure: do not leave sibling uploads running
      // after the caller tears down. Cancellation/failure never schedules the next batch.
      const results = await Promise.allSettled(pending);
      requireOpen();
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
`;
const CONSTANTS = `const MAX_PUSH_DELIVER_ATTEMPTS = 30;
/** Bound each upload to 1 MiB per batch; larger windows delay shared control RPCs. */
const UPLOAD_WINDOW = 2;`;

export function uploadCandidate(serialSource, window = 2) {
  assert(window === 2 || window === 4, "Experimental window must be 2 or 4");
  assert(
    serialSource.includes(SERIAL_LOOP) &&
      !serialSource.includes("const UPLOAD_WINDOW"),
    "Baseline changed: review the frozen upload experiment before rerunning",
  );
  assert(serialSource.includes("const MAX_PUSH_DELIVER_ATTEMPTS = 30;"));
  return serialSource
    .replace(
      "const MAX_PUSH_DELIVER_ATTEMPTS = 30;",
      CONSTANTS.replace("UPLOAD_WINDOW = 2", `UPLOAD_WINDOW = ${window}`),
    )
    .replace(SERIAL_LOOP, WINDOW_LOOP);
}
