import { useState } from 'react';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';
import { mountPage, subscription } from '../../ui-page/harness';

const source = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" rx="24" fill="#e0f2fe"/><circle cx="240" cy="125" r="64" fill="#0284c7"/><text x="240" y="245" text-anchor="middle" font-family="sans-serif" font-size="30">SVG Preview ✓</text></svg>';
function ScrollFixture() {
  const [generation, setGeneration] = useState(0);
  const longSource = source.replace('</svg>', '\n' + Array.from({ length: 300 }, (_, index) => `<!-- source line ${index} -->`).join('\n') + '\n</svg>');
  return <main className="flex h-screen flex-col">
    <button onClick={() => setGeneration(value => value + 1)}>Reopen SVG</button>
    <FileBodyView key={generation} workdir="/fixture-scroll" relPath="sample.svg" allowEdit={false}
      content={{ kind: 'text', relPath: 'sample.svg', content: longSource, size: longSource.length, mtimeMs: 0, truncated: false }} />
  </main>;
}
mountPage({
  host: (ctx) => ({
    appShortcuts: { getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }), onChanged: subscription('shortcuts') },
  }),
  render: (ctx) => ctx.case === 'source-scroll' ? <ScrollFixture /> : <main className="flex h-screen flex-col"><FileBodyView
    workdir="/fixture" relPath="sample.svg" allowEdit={false}
    content={{ kind: 'text', relPath: 'sample.svg', content: source, size: source.length, mtimeMs: 0, truncated: false }}
  /></main>,
});
