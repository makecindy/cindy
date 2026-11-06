// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedOfficeDocument } from '@/lib/officePreview';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@/lib/officePreview', async (load) => ({
  ...(await load<typeof import('@/lib/officePreview')>()),
  parseOfficeDocument: parse,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { OfficePreview } from '../OfficePreview';

// Production OfficePreview: observable sheet switching, size/error states and
// late-result isolation (attachment-preview.md lifecycle contract). PdfPreview
// tests do not cover Office decoding. Minimal races use deferred promises, no I/O
// or real waits. Unit tier; parser security/format coverage is in officePreview.test.
afterEach(() => {
  cleanup();
  parse.mockReset();
});

describe('OfficePreview', () => {
  it('switches workbook sheets and discards both stale results and selection on file changes', async () => {
    let resolveOld!: (doc: ParsedOfficeDocument) => void;
    parse.mockReturnValueOnce(
      new Promise<ParsedOfficeDocument>((resolve) => {
        resolveOld = resolve;
      }),
    );
    const view = render(<OfficePreview filePath="/first.docx" size={20} mtimeMs={1} />);
    parse.mockResolvedValueOnce({
      kind: 'sheet',
      size: 20,
      sheets: [
        { name: 'Summary', html: '<p>Inventory</p>' },
        { name: 'Details', html: '<p>Items</p>' },
      ],
    });
    view.rerender(<OfficePreview filePath="/second.xlsx" size={20} mtimeMs={1} />);
    expect(await screen.findByText('Inventory')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Items')).toBeTruthy();
    await act(async () => {
      resolveOld({ kind: 'word', html: '<p>Old document</p>', size: 20 });
    });
    expect(screen.queryByText('Old document')).toBeNull();
    expect(screen.getByText('Items')).toBeTruthy();
    parse.mockResolvedValueOnce({
      kind: 'sheet',
      size: 20,
      sheets: [
        { name: 'Summary', html: '<p>Updated inventory</p>' },
        { name: 'Details', html: '<p>New items</p>' },
      ],
    });
    view.rerender(<OfficePreview filePath="/second.xlsx" size={20} mtimeMs={2} />);
    expect(screen.queryByText('Items')).toBeNull();
    expect(await screen.findByText('Updated inventory')).toBeTruthy();
  });

  it('does not read oversized files and shows a localized decoding error without parser details', async () => {
    const view = render(<OfficePreview filePath="/big.docx" size={11 * 1024 * 1024} mtimeMs={1} />);
    expect(screen.getByText('chat.textLightbox.oversizeBody')).toBeTruthy();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRejectedValueOnce(new Error('private parser detail'));
    view.rerender(<OfficePreview filePath="/bad.docx" size={20} mtimeMs={1} />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'chat.textLightbox.unreadable',
    );
    expect(screen.queryByText('private parser detail')).toBeNull();
    parse.mockResolvedValueOnce({ kind: 'word', html: '<p>Recovered document</p>', size: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.retry' }));
    expect(await screen.findByText('Recovered document')).toBeTruthy();
  });
});
