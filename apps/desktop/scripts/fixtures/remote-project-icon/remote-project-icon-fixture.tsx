import { AppFrame, mountPage } from '../../ui-page/harness';
import { RemoteProjectIcon } from '../../../src/renderer/features/cc-agent/sidebar/RemoteProjectIcon';
import type { DeviceLinkConnectionStatus } from '../../../src/renderer/lib/ccAgent.types';

// The three device-link connection states side by side, inside sidebar row geometry.
// `connecting` is new: cold-start cache seed / relay reconnect, before any authoritative
// snapshot. It must read as "still checking" (normal glyph, dimmed), not as offline.
const ROWS: Array<{ status: DeviceLinkConnectionStatus; label: string }> = [
  { status: 'connected', label: 'Studio iMac' },
  { status: 'connecting', label: 'MacBook Air' },
  { status: 'disconnected', label: 'Office PC' },
];

function RemoteProjectIconPage() {
  const sidebar = (
    <div className="flex w-full flex-col gap-0.5 pt-3" data-ui-page-subject>
      {ROWS.map((row) => (
        <div
          key={row.status}
          data-testid={`row-${row.status}`}
          className="flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] text-[var(--text-primary)]"
        >
          <span className="min-w-0 max-w-full shrink truncate">{row.label}</span>
          <RemoteProjectIcon
            kind="device-link"
            connectionStatus={row.status}
            className="text-[var(--folder-item-icon)]"
          />
        </div>
      ))}
      <div
        data-testid="row-ssh"
        className="flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] text-[var(--text-primary)]"
      >
        <span className="min-w-0 max-w-full shrink truncate">build-server</span>
        <RemoteProjectIcon kind="ssh" className="text-[var(--folder-item-icon)]" />
      </div>
    </div>
  );
  return (
    <AppFrame sidebar={sidebar}>
      <div className="min-h-0 flex-1 p-6" />
    </AppFrame>
  );
}

void mountPage({
  render: () => <RemoteProjectIconPage />,
});
