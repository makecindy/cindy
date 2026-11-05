// Browser regression: real GhostToolCard retained its old iframe height after horizontal
// reflow. Existing source/unit checks cannot measure wrapping. Minimal input: static
// paragraphs, a footer action and one width marker; UI tier, no live plugin required.
export default {
  name: 'plugin-card-width',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 1000 },
  real: 'GhostToolCard, iframe srcdoc, theme variables and ResizeObserver',
  notCovered: 'Live plugin execution, remote mobile WebView and height persistence across app restart',
  cases: {
    default: { about: 'Full-width report shrinks and grows with the conversation' },
    animated: { about: 'Static width declaration also governs the running animation document' },
    overflow: { about: 'Visible overflow below a fixed-height container keeps the footer visible' },
    narrow: { about: 'Phone-sized conversation without horizontal overflow', viewport: { width: 320, height: 1000 } },
    poster: { about: 'Unmarked posters retain their existing width limit' },
  },
  async check(page, ui) {
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('button'));
    const fit = () => page.waitForFunction(() => {
      const frame = document.querySelector('iframe');
      const body = frame.contentDocument.body;
      const last = body.querySelector('button').getBoundingClientRect();
      return Math.abs(frame.getBoundingClientRect().height - Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight))) <= 2
        && last.bottom <= frame.clientHeight + 1;
    }, null, { timeout: 3000 });
    const width = await page.locator('iframe').evaluate(frame => frame.getBoundingClientRect().width);
    const available = await page.locator('[data-card-container]').evaluate(el => el.clientWidth);
    if (ui.case === 'poster') {
      if (Math.abs(width - Math.min(460, available)) > 1) throw new Error('Unmarked poster width changed');
      return;
    }
    if (Math.abs(width - available) > 1) throw new Error('Full-width card did not fill the message column');
    await fit();
    if (ui.case === 'narrow' || ui.case === 'overflow') return;
    await page.locator('[data-card-container]').evaluate(el => { el.style.width = '300px'; });
    await fit();
    const narrowHeight = await page.locator('iframe').evaluate(el => el.clientHeight);
    await ui.capture('narrow');
    await page.locator('[data-card-container]').evaluate(el => { el.style.width = '100%'; });
    await fit();
    const wideHeight = await page.locator('iframe').evaluate(el => el.clientHeight);
    if (wideHeight >= narrowHeight) throw new Error('Widening the card left stale empty space');
    await ui.capture('wide');
  },
};
