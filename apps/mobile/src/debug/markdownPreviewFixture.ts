/** Dev visual-mock files for black-box reading, formula panning and file paging. */
export const markdownPreviewFixture = [
  '# Markdown reading fixture',
  '',
  'Short inline formula $x^2 + y^2 = z^2$ stays in this paragraph.',
  '',
  'Wide inline formula $\\frac{'
    + Array.from({ length: 32 }, (_, index) => `x_{${index}}`).join(' + ')
    + '}{2} = \\mathrm{INLINEEND}$ followed by readable text.',
  '',
  '## Wide formula',
  '',
  '$$',
  Array.from({ length: 24 }, (_, index) => `x_{${index}}`).join(' + ') + ' = \\mathrm{END}',
  '$$',
  '',
  '## Wide table',
  '',
  '| Name | Description | Long value | Status |',
  '| --- | --- | --- | --- |',
  '| A | Markdown table wrapping | abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz | Complete |',
  '',
  ...Array.from({ length: 30 }, (_, index) => (
    `## Section ${index + 1}\n\nReading paragraph ${index + 1}. Scroll vertically with a slight sideways drift. `
    + 'A horizontal swipe in this paragraph switches files. Long press to select this text.\n'
  )),
].join('\n');
