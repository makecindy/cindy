import type { CSSProperties } from 'react';
import { Monitor } from 'lucide-react';
import { RightSidebarToggle } from '../../../src/renderer/components/layout/RightSidebarToggle';
import { RemoteSessionLoading } from '../../../src/renderer/features/cc-agent/RemoteSessionLoading';
import { mountPage } from '../../ui-page/harness';

mountPage({
  render: ({ data }) => {
    const { side, count, width } = data as {
      side: 'left' | 'right';
      count: number;
      width: number;
    };
    const style = {
      width,
      [`--content-top-${side}-actions-inset`]: `${count * 32}px`,
    } as CSSProperties;

    return (
      <div className="bg-content-area pt-12">
        <section className="relative mx-auto min-h-32 border-t border-border" style={style}>
          {count > 0 && (
            <div
              data-corner-actions
              className={`pointer-events-none absolute top-1 z-float flex items-center gap-1 ${
                side === 'left' ? 'left-2 flex-row-reverse' : 'right-2'
              }`}
            >
              {Array.from({ length: count - 1 }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  aria-label={`Screen ${index + 1}`}
                  className="pointer-events-auto flex size-7 items-center justify-center text-[var(--text-secondary)]"
                >
                  <Monitor size={15} />
                </button>
              ))}
              <RightSidebarToggle collapsed side={side} onToggle={() => {}} />
            </div>
          )}
          <RemoteSessionLoading compact />
        </section>
      </div>
    );
  },
});
