import assert from 'node:assert/strict';

export default {
  name: 'skillhub-cards',
  entry: './skillhub-cards-fixture.tsx',
  viewport: { width: 800, height: 480 },
  real: 'HomeMarketCard, SkillIcon, SkillTagList, font settings and theme tokens',
  notCovered: 'Live catalog, pagination, installation and full application navigation',
  cases: { default: { about: 'Default and maximum UI font sizes with neutral category artwork' } },
  async ready(page) {
    await page.getByTestId('home-card').waitFor();
  },
  async check(page, ui) {
    for (const [label, size] of [['Default font', 14], ['Large font', 24]]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction((expected) => getComputedStyle(document.documentElement).getPropertyValue('--app-ui-font-size') === expected + 'px', size);
      const measurements = await page.getByTestId('home-card').evaluate((card) => {
        const description = card.querySelector('p');
        const title = card.querySelector('button');
        const footer = description.nextElementSibling;
        const avatar = card.querySelector('svg').parentElement;
        return {
          lines: [title, description, footer].map((element) => {
            const style = getComputedStyle(element);
            return { font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
          }),
          descriptionBottom: description.getBoundingClientRect().bottom,
          footerTop: footer.getBoundingClientRect().top,
          background: getComputedStyle(avatar).backgroundColor,
          cardBackground: getComputedStyle(card.firstElementChild).backgroundColor,
        };
      });
      for (const { font, line } of measurements.lines) {
        assert.ok(line >= font * 1.3, `UI size ${size}: line ${line} clips font ${font}`);
      }
      assert.ok(measurements.footerTop >= measurements.descriptionBottom);
      if (size === 24) assert.equal(measurements.background, measurements.cardBackground);
      await ui.capture('font-' + size);
    }
  },
};
