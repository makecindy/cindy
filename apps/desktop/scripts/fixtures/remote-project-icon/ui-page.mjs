import assert from 'node:assert/strict';

/**
 * Sidebar remote-project icon in its three device-link states. Guards the new `connecting`
 * state (DESIGN.md §5 Layout Structure — sidebar rows; §11 Voice & Content — an in-progress
 * state must not be drawn as a failure): connecting keeps the normal device glyph, dimmed like
 * disconnected, while only disconnected uses the MonitorOff glyph.
 */
export default {
  name: 'remote-project-icon',
  entry: './remote-project-icon-fixture.tsx',
  viewport: { width: 760, height: 320 },
  real: 'RemoteProjectIcon, lucide glyphs, sidebar row typography, theme tokens',
  notCovered:
    'Live device-link state transitions, project headers / session rows that pass the status in, tooltips',
  cases: {
    default: { about: 'connected / connecting / disconnected device-link rows plus an SSH row' },
  },
  async ready(page) {
    await page.getByTestId('row-disconnected').locator('svg').waitFor();
  },
  async check(page) {
    const glyph = async (row) => {
      const svg = page.getByTestId(row).locator('svg');
      return svg.evaluate((el) => ({
        className: el.getAttribute('class') ?? '',
        opacity: el.ownerDocument.defaultView.getComputedStyle(el).opacity,
      }));
    };
    const connected = await glyph('row-connected');
    const connecting = await glyph('row-connecting');
    const disconnected = await glyph('row-disconnected');
    assert.match(connected.className, /lucide-monitor-smartphone/, 'connected uses the device glyph');
    assert.equal(connected.opacity, '1', 'connected is not dimmed');
    assert.match(connecting.className, /lucide-monitor-smartphone/, 'connecting keeps the device glyph');
    assert.doesNotMatch(connecting.className, /lucide-monitor-off/, 'connecting is not drawn as offline');
    assert.equal(connecting.opacity, '0.75', 'connecting is dimmed');
    assert.match(disconnected.className, /lucide-monitor-off/, 'disconnected uses the off glyph');
    assert.equal(disconnected.opacity, '0.75', 'disconnected is dimmed');
    const ssh = await glyph('row-ssh');
    assert.match(ssh.className, /lucide-globe/, 'ssh keeps the globe glyph');
  },
};
