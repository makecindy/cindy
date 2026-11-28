import { useState } from 'react';

import { mountPage } from '../../ui-page/harness';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';
import type { FileContent } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileContent';

// PR: a chat file link with a line number opens the sidebar preview anchored on that
// line. Unit tests prove the command routing and the reveal state; they cannot prove
// the editor really scrolled and stayed editable inside the sidebar pane.
// Minimum failures: no scroll at all, the wrong line in view, or the one-shot line
// never reported as consumed (so the host would re-anchor on every render).
// Tier: opt-in UI integration over a fabricated file; no filesystem, no IPC, no chat.

const TARGET_LINE = 42;
const LINE_COUNT = 400;
const SOURCE = Array.from(
  { length: LINE_COUNT },
  (_, index) => `const value${index + 1} = ${index + 1}; // line ${index + 1}`,
).join('\n');

const CONTENT: FileContent = {
  kind: 'text',
  content: SOURCE,
  relPath: 'src/app.ts',
  size: SOURCE.length,
  mtimeMs: 0,
  truncated: false,
};

function Preview() {
  const [consumed, setConsumed] = useState(false);
  return (
    <div className="flex h-screen flex-col bg-content-area" data-consumed={consumed ? 'yes' : 'no'}>
      <div className="min-h-0 flex-1">
        <FileBodyView
          workdir="/fixture/repo"
          relPath="src/app.ts"
          content={CONTENT}
          allowEdit={false}
          jumpLine={TARGET_LINE}
          jumpLineNonce={1}
          onJumpLineConsumed={() => setConsumed(true)}
        />
      </div>
    </div>
  );
}

mountPage({
  // 预览只吃 props：行号、文件内容、会话都来自夹具，不碰文件系统。
  host: () => ({}),
  render: () => <Preview />,
});
