// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { TFunction } from 'i18next';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
  }),
}));

import { TabBodyErrorBoundary } from '../TabBodyErrorBoundary';

afterEach(() => cleanup());

const t = ((key: string) => key) as TFunction;

function ThrowingBody({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('bridge missing');
  return <div>panel content</div>;
}

describe('TabBodyErrorBoundary', () => {
  it('isolates a crashed tab and shows a localized reload action', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <TabBodyErrorBoundary tabId="broken" tabKind="web-browser" t={t}>
          <ThrowingBody shouldThrow />
        </TabBodyErrorBoundary>
        <TabBodyErrorBoundary tabId="healthy" tabKind="terminal" t={t}>
          <div>healthy panel</div>
        </TabBodyErrorBoundary>
      </div>,
    );

    expect(screen.getByText('rightSidebar.panelError.title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'rightSidebar.panelError.reload' })).toBeTruthy();
    expect(screen.getByText('healthy panel')).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('remounts the failed tab after retry', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShouldThrow(false)}>
            make healthy
          </button>
          <TabBodyErrorBoundary tabId="broken" tabKind="review" t={t}>
            <ThrowingBody shouldThrow={shouldThrow} />
          </TabBodyErrorBoundary>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText('rightSidebar.panelError.title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'make healthy' }));
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.panelError.reload' }));
    expect(screen.getByText('panel content')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.panelError.title')).toBeNull();
    errorSpy.mockRestore();
  });
});
