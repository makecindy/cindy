/** The native sheet supplies its measured pane width; compatibility sheets keep the existing 100% rule. */
export function androidUpdateSheetFrameWidth(nativeSheet: boolean, viewportWidth: number): number | '100%' {
  return nativeSheet ? viewportWidth : '100%';
}
