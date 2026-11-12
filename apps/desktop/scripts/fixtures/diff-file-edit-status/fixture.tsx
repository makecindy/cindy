import { useRef } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import {
  FileBodyView,
  type FileBodyHandle,
} from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';

const patch = [
  '--- a/file',
  '+++ b/file',
  '@@ -1,201 +1,201 @@',
  ...Array.from({ length: 200 }, () => ' context'),
  '----',
  '+++counter;',
].join('\n');
const code = Array.from({ length: 40 }, () => 'const counter = 0;').join('\n');
const fencedPatch = [
  '--- a/file', '+++ b/file', '@@ -1,2 +1 @@',
  '---counter;', '----', '+++counter;',
  '--- a/next', '+++ b/next',
].join('\n');

function FenceFixture({ language }: { language: 'diff' | 'patch' }) {
  return (
    <main className="p-4">
      <MarkdownRenderer content={'```' + language + '\n' + fencedPatch + '\n```'} />
    </main>
  );
}

function Fixture({ diff }: { diff: boolean }) {
  const handle = useRef<FileBodyHandle>(null);
  const text = diff ? patch : code;
  const relPath = diff ? 'sample.patch' : 'sample.ts';
  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden">
      <button data-ui-page-control data-testid="save" onClick={() => void handle.current?.save()}>
        Save fixture
      </button>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <FileBodyView
          ref={handle}
          workdir="/fixture"
          relPath={relPath}
          content={{
            kind: 'text',
            relPath,
            content: text,
            size: text.length,
            mtimeMs: 0,
            truncated: false,
          }}
        />
      </div>
    </main>
  );
}

mountPage({
  host: (ctx) => ({
    appShortcuts: {
      getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }),
      onChanged: subscription('shortcuts'),
    },
    // Hold an in-memory save open to observe the delayed saving status. No disk IO.
    fileBrowser: { writeFile: () => new Promise(() => {}) },
  }),
  render: (ctx) => ctx.case === 'patch-fence' || ctx.case === 'diff-fence'
    ? <FenceFixture language={ctx.case === 'patch-fence' ? 'patch' : 'diff'} />
    : <Fixture diff={ctx.case === 'diff-scroll'} />,
});
