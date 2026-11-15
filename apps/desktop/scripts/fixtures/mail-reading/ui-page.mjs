export default {
  name: 'mail-reading',
  entry: './fixture.tsx',
  real: 'MailHtmlPreview and shared sanitized reading document',
  notCovered: 'Mailbox access, original remote image fetching and native mobile WebView',
  viewport: { width: 640, height: 700 },
  cases: {
    default: { about: 'Authored light colors, readable dark palette and collapsed source indentation' },
    narrow: { about: 'Sender responsive layout in a narrow reader', viewport: { width: 320, height: 700 } },
    'fixed-width': { about: 'A fixed-width message remains scrollable inside its own document', viewport: { width: 320, height: 400 } },
  },
  async check(page, ui) {
    await page.locator('iframe[aria-busy="false"]').waitFor();
    const result = await page.evaluate(() => {
      const frame = document.querySelector('iframe'), doc = frame.contentDocument;
      const css = el => doc.defaultView.getComputedStyle(el);
      if (!doc.querySelector('.card')) {
        doc.scrollingElement.scrollLeft = 800;
        return { scroll: doc.scrollingElement.scrollLeft, scrolling: frame.getAttribute('scrolling'), color: css(doc.querySelector('td')).color };
      }
      const paragraphs = [...doc.querySelectorAll('.address p')];
      return {
        background: css(doc.querySelector('.card')).backgroundColor,
        color: css(paragraphs[0]).color,
        heights: paragraphs.map(el => el.getBoundingClientRect().height),
        runs: doc.querySelectorAll('[data-cindy-mail-run]').length,
        padding: css(doc.querySelector('.address')).paddingLeft,
        gradient: css(doc.querySelector('.gradient')).backgroundImage,
      };
    });
    if (ui.case === 'fixed-width') {
      if (result.scroll <= 0 || result.scrolling === 'no') throw new Error('Fixed-width mail is clipped instead of scrollable');
      if (ui.theme === 'dark' && result.color === 'rgb(17, 17, 17)') throw new Error('Inherited text stayed dark');
      return;
    }
    if (result.background !== (ui.theme === 'dark' ? 'rgb(129, 71, 14)' : 'rgb(249, 154, 60)')) throw new Error('Mail background lost its intended hue/brightness');
    if (ui.theme === 'dark' ? result.gradient !== 'none' : !result.gradient.includes('linear-gradient')) throw new Error('Gradient decoration must clear only in dark mode');
    if (ui.theme === 'light' && result.color !== 'rgb(0, 0, 0)') throw new Error('Authored light text changed');
    if (ui.theme === 'dark' && result.color === 'rgb(0, 0, 0)') throw new Error('Text was not adapted to the dark background');
    if (result.runs || result.heights.some(height => height !== 28)) throw new Error('Source indentation changed the rendered line spacing');
    if (result.padding !== (ui.case === 'narrow' ? '25px' : '55px')) throw new Error('Sender responsive CSS was lost');
  },
};
