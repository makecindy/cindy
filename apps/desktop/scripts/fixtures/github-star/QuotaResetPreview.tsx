import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../src/renderer/components/ui/button';
import { QuotaBar } from '../../../src/renderer/components/status/QuotaBar';
import { QuotaResetConfetti } from '../../../src/renderer/components/status/QuotaResetConfetti';
import { useQuotaResetRollup } from '../../../src/renderer/components/status/quotaResetRollup';

function Reveal({ play }: { play: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState({
    key: 'preview-5h',
    remainingPercent: 0,
    resetsAtMs: Date.now() - 1000,
  });
  const [burst, setBurst] = useState(false);
  const rollup = useQuotaResetRollup(slot);
  useEffect(() => {
    if (!play) return;
    const timer = setTimeout(() => {
      setSlot((value) => ({
        ...value,
        remainingPercent: 100,
        resetsAtMs: Date.now() + 5 * 3600_000,
      }));
      setBurst(true);
    }, 450);
    return () => clearTimeout(timer);
  }, [play]);
  return (
    <div className="flex items-center gap-3 text-12 text-[var(--text-secondary)]">
      <span>订阅余量</span>
      <span ref={anchor} className="inline-flex items-center gap-2 tabular-nums">
        <span>5 小时</span>
        <span style={{ color: rollup?.celebrating ? 'var(--card-status-done)' : undefined }}>
          {rollup?.percent ?? 0}%
        </span>
        <QuotaBar
          size="mini"
          usedPercent={100 - (rollup?.percent ?? 0)}
          showRemaining
          ariaLabel="模拟订阅余量"
        />
      </span>
      {burst && anchor.current && (
        <QuotaResetConfetti anchor={anchor.current} onDone={() => setBurst(false)} />
      )}
    </div>
  );
}

export function QuotaResetPreview() {
  const [run, setRun] = useState(0);
  return (
    <>
      <div
        data-ui-page-control
        className="absolute bottom-20 inset-x-0 flex flex-col items-center gap-2 px-4"
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="secondary"
            data-preview-quota
            onClick={() => setRun((value) => value + 1)}
          >
            预览额度重置
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          轻量礼花 · 模拟余量，使用真实数字滚动和礼花组件
        </p>
      </div>
      <footer className="absolute bottom-0 inset-x-0 flex justify-center border-t border-[var(--border-default)] px-4 py-3">
        <Reveal key={run} play={run > 0} />
      </footer>
    </>
  );
}
