/** Safe errors only: never send upstream bodies, paths or credentials across IPC. */
export class SpeechError extends Error {
  constructor(readonly code: 'unavailable' | 'request' | 'format' | 'cancelled' | 'timeout') {
    super(code);
  }
}
