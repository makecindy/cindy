import { Download, X } from 'lucide-react';
import { PreviewButton } from '../../../src/renderer/components/chat/PreviewChrome';
import { Toast } from '../../../src/renderer/components/ui/toast/Toast';
import { mountPage } from '../../ui-page/harness';

function Fixture({ kind }: { kind: string }) {
  if (kind === 'preview-button') {
    return (
      <div className="flex items-center gap-1 p-6">
        <PreviewButton label="Download" onClick={() => {}}>
          <Download className="h-4 w-4" />
        </PreviewButton>
        <PreviewButton label="Close" onClick={() => {}}>
          <X className="h-4 w-4" />
        </PreviewButton>
      </div>
    );
  }
  return (
    <div className="p-6">
      <Toast
        item={{
          id: 'fixture-toast',
          variant: 'info',
          title: 'Update ready',
          message: 'Restart Cindy to finish installing the new version.',
          dismissLabel: 'Later',
          duration: 0,
          createdAt: 1,
          exiting: false,
        }}
      />
    </div>
  );
}

void mountPage({ render: (ctx) => <Fixture kind={ctx.case} /> });
