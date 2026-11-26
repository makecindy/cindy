import { useRef } from 'react';
import { AppFrame, mountPage } from '../../ui-page/harness';
import { SelectionQuoteButton } from '../../../src/renderer/components/chat/SelectionQuoteButton';
import { MessageAnnotations } from '../../../src/renderer/components/chat/MessageAnnotations';
import { annotationSourceVersion, type MessageAnnotation, type MessageAnnotationRequest } from '../../../src/shared/messageAnnotations';

const source = '第一点：待验证。第二点：待验证。请分别检查方案与实现。';
function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  return <AppFrame><div ref={ref} className="h-screen overflow-auto p-6 text-foreground">
    <div className="mx-auto max-w-xl pt-12">
      <h2 className="mb-6 text-lg font-semibold">审阅实现方案</h2>
      <div data-selection-quote-scope="" data-annotation-message="fixture-response" data-annotation-session="fixture-task"
        data-annotation-version={annotationSourceVersion(source)} className="text-base leading-8">
        <div data-selection-quote-body=""><p>第一点：待验证。</p><p>第二点：<strong data-test-second="">待验证。</strong></p><p>请分别检查方案与实现。</p></div>
      </div>
    </div>
    <SelectionQuoteButton sessionId="fixture-task" containerRef={ref} onAskInSideChat={async () => false} />
    <MessageAnnotations sessionId="fixture-task" containerRef={ref} />
  </div></AppFrame>;
}
void mountPage({
  host: () => {
    let records: MessageAnnotation[] = [];
    return {
      ghosts: { listSync: () => ({ ghosts: [{ enabled: true, approval: { state: 'approved' }, manifest: {
        schemaVersion: 3, id: 'annotation-fixture', tools: [], mcpApps: { host: { capabilities: ['annotations'] } },
      } }] }), onChanged: () => () => {} },
      onSelectionContextMenuAddToChat: () => () => {},
      localDb: { messageAnnotations: async (request: MessageAnnotationRequest) => {
        if (request.action === 'add') records = [...records, { ...request.anchor, sessionId: request.sessionId,
          id: 'fixture-annotation', ordinal: 1, comment: request.comment, createdAt: 1, sentAt: null }];
        if (request.action === 'remove') records = records.filter(item => item.id !== request.id);
        return records;
      } },
    };
  },
  render: () => <Fixture />,
});
