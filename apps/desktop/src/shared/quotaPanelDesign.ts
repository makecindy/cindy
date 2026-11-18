/**
 * Presentation contract for the Swift menu-bar panel and the Windows tray panel.
 * Main sends this with every view. Both renderers consume these metrics and colors;
 * changes here reach both platforms without copying CSS values into Swift.
 */
export const QUOTA_PANEL_DESIGN = {
  metrics: {
    widthTwo: 320, widthThree: 332, widthFour: 350, widthMany: 368,
    shortScreenHeight: 1000, heightShare: 0.86,
    tubeShort: 82, tubeTall: 104, rowsShort: 2, rowsTall: 3,
    ringShort: 160, ringTall: 188, panelRadius: 20, tileRadius: 14,
  },
  colors: {
    ink: ['#26221ceb', '#f2efe9f0'],
    ink2: ['#26221c99', '#f2efe99e'],
    ink3: ['#26221c6b', '#f2efe96b'],
    ink4: ['#26221c24', '#f2efe921'],
    ink5: ['#26221c0d', '#f2efe90d'],
    line: ['#26221c14', '#f2efe912'],
    tile: ['#ffffff73', '#f2efe90d'],
    edge: ['#ffffffcc', '#f2efe917'],
    cta: ['#1f1e1c', '#f2efe9'],
    liquid: ['#26221c75', '#f2efe9b8'],
    fill: ['#26221c6b', '#f2efe9cc'],
    onInk: ['#ffffff', '#0e0e0d'],
    /** Windows only: the opaque tone under the tint, standing in for the macOS blur material. */
    panelBase: ['#d6d4d1', '#262523'],
    panelTint: ['#f8f7f380', '#1a19188a'],
    panelGlow: ['#ea6b1717', '#ea6b171f'],
    panelGlow2: ['#ffffff8c', '#fff4e40a'],
    wellTop: ['#ffffffb3', '#f2efe912'],
    wellBottom: ['#ffffff80', '#f2efe906'],
    wellShade: ['#00000014', '#00000080'],
    brand: ['#f70121', '#f70121'],
    warn: ['#f3a115', '#f3a115'],
    error: ['#ef4444', '#ef4444'],
    claude: ['#d97757', '#d97757'],
    claude2: ['#e8a184', '#e8a184'],
    claude3: ['#f2c9b6', '#f2c9b6'],
    codex: ['#7a9dff', '#7a9dff'],
    pi: ['#14b8a6', '#2dd4bf'],
  },
};
export type QuotaPanelDesign = typeof QUOTA_PANEL_DESIGN;

export function quotaPanelWidth(tubes: number): number {
  const m = QUOTA_PANEL_DESIGN.metrics;
  return tubes <= 2 ? m.widthTwo : tubes === 3 ? m.widthThree : tubes === 4 ? m.widthFour : m.widthMany;
}
