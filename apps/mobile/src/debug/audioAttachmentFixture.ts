export const AUDIO_ATTACHMENT_FIXTURE = 'visual-companion-audio';

const audioUrl = (digit: string) => `cindy-media://blobs/${digit.repeat(64)}.wav`;
export const audioFixtureTracks = [
  { title: 'PCM WAV · 40 kHz Stereo', xdt_audio_url: audioUrl('1') },
  { title: 'PCM WAV · Retry after read failure', xdt_audio_url: audioUrl('2') },
  { title: 'PCM WAV · Invalid source', xdt_audio_url: audioUrl('3') },
  { title: '小猫观察日记 · 片头旁白和客厅环境声 · 第三版试听录音.wav', xdt_audio_url: audioUrl('4') },
];

function toneWav(rate = 40_000, seconds = 0.4, channels = 2) {
  const frames = rate * seconds;
  const frameBytes = channels * 2;
  const bytes = new Uint8Array(44 + frameBytes * frames);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * frameBytes, true);
  for (let i = 0; i < frames; i++) {
    const fade = Math.min(1, i / (rate / 50), (frames - 1 - i) / (rate / 50));
    const frequency = channels === 1 && i >= frames / 2 ? 660 : 440;
    const sample = 7_000 * fade * Math.sin(2 * Math.PI * frequency * i / rate);
    const offset = 44 + frameBytes * i;
    view.setInt16(offset, sample, true);
    if (channels === 2) view.setInt16(offset + 2, sample, true);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { ossKey: '', mimeType: 'audio/wav', size: bytes.length, inlineBase64: btoa(binary) };
}

export async function audioAttachmentFixture(request: { url?: string; skipCache?: boolean }) {
  const index = audioFixtureTracks.findIndex(track => track.xdt_audio_url === request.url);
  if (index === -1) return undefined;
  // Long enough to observe the loading state when exercising the complete card.
  await new Promise(resolve => setTimeout(resolve, 700));
  if (index === 1 && !request.skipCache) throw new Error('Synthetic audio read failed');
  if (index === 2) return { ossKey: '', mimeType: 'audio/wav', size: 9, inlineBase64: btoa('bad audio') };
  if (index === 3) return toneWav(8_000, 3.75, 1); // Longer seek sample, still below the 64 KiB limit.
  return toneWav();
}
