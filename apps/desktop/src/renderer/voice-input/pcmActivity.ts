// This is a conservative silence check, not speech recognition. Keep any
// plausible sound (including background noise) rather than discard quiet words.
// PCM16 RMS 32 is about -60 dBFS; a short peak also keeps a very brief sound.
export function hasPcmSound(pcm: ArrayBuffer): boolean {
  if (pcm.byteLength % 2 !== 0) return true; // Unknown data must not be discarded.
  const samples = new Int16Array(pcm);
  let energy = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= 128) return true;
    energy += sample * sample;
  }
  return samples.length > 0 && energy >= samples.length * 32 * 32;
}
