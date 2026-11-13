import { SpeechError } from '../speechError.js';

/** Bounded, pull-driven SSE framing. Join multi-line data before JSON parsing;
 * protocol decoders own completion and must reject truncated/error streams. */
export function ssePcmStream(
  body: ReadableStream<Uint8Array>,
  decode: (event: unknown) => Uint8Array | undefined,
  finished: () => boolean,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eof = false;
  let encodedBytes = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            const delimiter = /\r?\n\r?\n/.exec(buffer);
            if (delimiter || (eof && buffer)) {
              const frame = delimiter ? buffer.slice(0, delimiter.index) : buffer;
              buffer = delimiter ? buffer.slice(delimiter.index + delimiter[0].length) : '';
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue; // SSE comments/keep-alives.
              if (data === '[DONE]') {
                if (!finished()) throw new SpeechError('format');
                continue;
              }
              const pcm = decode(JSON.parse(data));
              if (!pcm?.byteLength) continue;
              controller.enqueue(pcm);
              return;
            }
            if (eof) {
              if (!finished()) throw new SpeechError('format');
              reader.releaseLock();
              controller.close();
              return;
            }
            const chunk = await reader.read();
            eof = chunk.done;
            encodedBytes += chunk.value?.byteLength ?? 0;
            if ((chunk.value?.byteLength ?? 0) > 2_097_152 || encodedBytes > 64 * 1024 * 1024)
              throw new SpeechError('format');
            buffer += decoder.decode(chunk.value, { stream: !eof });
            if (buffer.length > 2_097_152) throw new SpeechError('format');
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error instanceof SpeechError ? error : new SpeechError('format'));
        }
      },
      cancel: () => reader.cancel(),
    },
    { highWaterMark: 0 },
  );
}
