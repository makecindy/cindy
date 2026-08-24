// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteDesktopConfirmationNotice } from '../RemoteDesktopConfirmationNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('RemoteDesktopConfirmationNotice', () => {
  it('renders a read-only status without confirmation actions', () => {
    render(<RemoteDesktopConfirmationNotice />);

    const status = screen.getByRole('status');

    expect(status.className).toContain('rounded-[12px]');
    expect(status.textContent).toContain(
      'ccAgent.remoteDesktopConfirmation.title',
    );
    expect(status.textContent).toContain(
      'ccAgent.remoteDesktopConfirmation.description',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
