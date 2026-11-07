/** Old hosts omit availability; retain their finite nonnegative numeric counts. */
export function hasDownloadCount(skill: { downloads: number; downloadsAvailable?: boolean }): boolean {
  return skill.downloadsAvailable !== false && Number.isFinite(skill.downloads) && skill.downloads >= 0;
}
