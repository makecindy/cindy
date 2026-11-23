/** Video containers served by the local file protocol. Codec support is probed by the player. */
export function isVideoPath(path: string): boolean {
  return /\.(mp4|m4v|mov|webm)$/i.test(path);
}
