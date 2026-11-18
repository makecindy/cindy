import type { ProviderShareOwnedView } from '../../../shared/providerShare';

// Quote every cell for commas, quotes and line breaks. Prefix spreadsheet formulas and
// leading apostrophes reversibly so importing the original file preserves literal text.
function cell(value: string): string {
  const safe = /^(?:'|[\t\r\n]|\s*[=+\-@＝＋－＠])/.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function providerShareRosterCsv(shares: readonly ProviderShareOwnedView[], capturedAt: string): string {
  const lines = ['share_id,member_id,display_name,note,status,captured_at'];
  for (const share of shares) {
    for (const member of share.members) {
      lines.push([share.shareId, member.memberId, member.displayName, member.note ?? '', member.status, capturedAt]
        .map(cell).join(','));
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function downloadProviderShareRoster(shares: readonly ProviderShareOwnedView[], capturedAt: string): void {
  const blob = new Blob([providerShareRosterCsv(shares, capturedAt)], { type: 'text/csv;charset=utf-8' });
  const urls = window.URL;
  const url = urls.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cindy-member-roster-' + capturedAt.replace(/[:.]/g, '-') + '.csv';
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    window.setTimeout(() => urls.revokeObjectURL(url), 1000);
  }
}
