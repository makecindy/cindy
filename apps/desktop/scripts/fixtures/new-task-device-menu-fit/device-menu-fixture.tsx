import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { DeviceSwitcherPill } from '../../../src/renderer/components/new-chat/DeviceSwitcherPill';
import type { SelectableDevice } from '../../../src/renderer/hooks/useControllableDevices';

const DEVICES: SelectableDevice[] = ['工作室主机', '书房笔记本', '测试机 A', '测试机 B', '构建机', '会议室电脑']
  .map((name, i) => ({ deviceId: `fixture-${i}`, name, platform: 'win32', online: i !== 3 }));

/**
 * The device pill sits where it does on the new-task page: below the 46px content
 * header plus max(96px, 28vh) top padding, 22px into the content column.
 */
function DeviceMenuFixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="fixed inset-0">
      <div
        className="absolute left-1/2 w-[720px] -translate-x-1/2"
        style={{ top: 'calc(46px + max(96px, 28vh))' }}
      >
        <div className="absolute right-0 top-[22px] z-10 inline-flex items-center gap-2">
          <DeviceSwitcherPill devices={DEVICES} value={value} onChange={setValue}
            open={open} onOpenChange={setOpen} />
        </div>
        <div className="mt-[60px] h-[120px] rounded-[18px] border border-[var(--create-agent-control-border)]" />
      </div>
    </div>
  );
}

mountPage({ render: () => <DeviceMenuFixture /> });
