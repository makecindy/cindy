// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuoteCommentSheet } from '@/session/QuoteCommentSheet';

const colors = {
  border: '#444444',
  surfaceElevated: '#222222',
  textPrimary: '#eeeeee',
  textSecondary: '#aaaaaa',
  textTertiary: '#777777',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: ({ accessibilityLabel, children, disabled, onPress, testID }: {
    accessibilityLabel?: string;
    children: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
    disabled?: boolean;
    onPress: () => void;
    testID?: string;
  }) => (
    <button
      aria-label={accessibilityLabel}
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
      type="button"
    >
      {typeof children === 'function' ? children({ pressed: false }) : children}
    </button>
  ),
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TextInput: ({ onChangeText, placeholder, placeholderTextColor, testID, value }: {
    onChangeText: (value: string) => void;
    placeholder?: string;
    placeholderTextColor?: string;
    testID?: string;
    value: string;
  }) => (
    <textarea
      data-placeholder-color={placeholderTextColor}
      data-testid={testID}
      onChange={(event) => onChangeText(event.target.value)}
      placeholder={placeholder}
      value={value}
    />
  ),
}));

vi.mock('@/session/ContextSheet', () => ({
  ContextSheet: ({ children, footer, visible }: {
    children: React.ReactNode;
    footer?: React.ReactNode;
    visible: boolean;
  }) => visible ? <section>{children}{footer}</section> : null,
  ContextSheetFooterButton: ({ disabled, label, onPress, testID }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
    testID?: string;
  }) => (
    <button data-testid={testID} disabled={disabled} onClick={onPress} type="button">
      {label}
    </button>
  ),
}));

vi.mock('@/theme', () => ({
  fontWeight: { medium: '500', semibold: '600' },
  lineHeight: { caption: 18 },
  radius: { control: 8, pill: 9999 },
  spacing: { sm: 8, md: 12, lg: 16 },
  typeScale: { body: 14, footnote: 12 },
  useTheme: () => ({ colors }),
  useThemedStyles: (factory: (themeColors: typeof colors) => unknown) => factory(colors),
}));

afterEach(cleanup);

describe('QuoteCommentSheet interaction', () => {
  it('keeps the original non-empty comment on submit and uses the tertiary placeholder color', () => {
    const onSubmit = vi.fn();
    const pending = {
      sessionId: 'session-a',
      quote: { text: 'selected', sourcePath: 'src/example.ts' },
    };
    render(
      <QuoteCommentSheet
        pending={pending}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByTestId('quoteCommentSheet.input');
    expect(input.getAttribute('data-placeholder-color')).toBe(colors.textTertiary);
    fireEvent.change(input, { target: { value: '\nfirst line\nsecond line\n' } });
    fireEvent.click(screen.getByTestId('quoteCommentSheet.addWithComment'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(pending, {
      text: 'selected',
      sourcePath: 'src/example.ts',
      comment: '\nfirst line\nsecond line\n',
    });
  });
});
