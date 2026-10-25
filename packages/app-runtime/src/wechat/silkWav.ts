const WAV_HEADER_BYTE_LENGTH = 44;

export class WavOutputLimitError extends Error {
  constructor() {
    super('WAV output exceeds the configured byte limit.');
    this.name = 'WavOutputLimitError';
  }
}

export function pcmS16leToWav(
  pcm: Uint8Array,
  sampleRate: number,
  maxOutputByteLength?: number,
): Uint8Array {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('Invalid PCM payload.');
  }
  if (
    maxOutputByteLength !== undefined &&
    pcm.byteLength > maxOutputByteLength - WAV_HEADER_BYTE_LENGTH
  ) {
    throw new WavOutputLimitError();
  }
  const result = Buffer.allocUnsafe(WAV_HEADER_BYTE_LENGTH + pcm.byteLength);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(36 + pcm.byteLength, 4);
  result.write('WAVE', 8, 'ascii');
  result.write('fmt ', 12, 'ascii');
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36, 'ascii');
  result.writeUInt32LE(pcm.byteLength, 40);
  result.set(pcm, 44);
  return result;
}
