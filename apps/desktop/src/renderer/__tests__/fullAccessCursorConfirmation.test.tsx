// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import copy from '../i18n/locales/en/common.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').reduce<unknown>((value, part) =>
    (value as Record<string, unknown>)[part], copy) as string }),
}));

import { FullAccessConfirmContent } from '../components/new-chat/FullAccessConfirmContent';

describe('Full access confirmation scope', () => {
  it('describes Cursor approval requests and preserves its native permission boundary', () => {
    render(<FullAccessConfirmContent cursor />);
    expect(screen.getByText('Directly allow file read and modification requests from Cursor')).toBeTruthy();
    expect(screen.getByText('Directly allow terminal command requests from Cursor')).toBeTruthy();
    expect(screen.getByText('Directly allow network operation requests from Cursor')).toBeTruthy();
    expect(screen.getByText(/Cursor’s native permission policy still applies/)).toBeTruthy();
    expect(screen.queryByText('Read and modify files outside the workspace')).toBeNull();
  });
});
