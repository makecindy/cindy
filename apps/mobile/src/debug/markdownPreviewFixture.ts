/** Dev visual-mock files for black-box reading, formula panning and file paging. */
export const markdownPreviewFixture = [
  '# Markdown reading fixture',
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
