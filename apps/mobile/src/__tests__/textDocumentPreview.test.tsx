// @vitest-environment jsdom
import type { CSSProperties, ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TextDocumentPreview } from '@/session/TextDocumentPreview';
import { darkColors, lightColors } from '@/theme/tokens';

let palette = lightColors;
vi.mock('@/theme', async () => ({
  ...await vi.importActual('@/theme/tokens'),
  monoFont: 'monospace', useTheme: () => ({ colors: palette }),
}));
vi.mock('react-native', () => ({ View: 'div', ScrollView: 'div', Alert: {} }));
vi.mock('lucide-react-native', () => ({ Copy: null, Search: null, WrapText: null, ListOrdered: null, ChevronLeft: null, ChevronRight: null, X: null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: vi.fn() }));
vi.mock('@/session/PreviewChrome', () => ({
  PreviewToolbar: 'div',
  PreviewIconButton: ({ label, onPress }: { label: string; onPress(): void }) => <button onClick={onPress}>{label}</button>,
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, style, selectable }: { children: ReactNode; style: CSSProperties; selectable?: boolean }) =>
    <span data-selectable={selectable} style={Array.isArray(style) ? Object.assign({}, ...style) : style}>{children}</span>,
  TextInput: ({ value, onChangeText }: { value: string; onChangeText(value: string): void }) =>
    <input value={value} onChange={event => onChangeText(event.target.value)} />,
}));
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem }: { data: string[]; renderItem(row: { item: string; index: number }): ReactNode }) =>
    data.map((item, index) => <div key={index}>{renderItem({ item, index })}</div>),
}));

afterEach(cleanup);

it.each([lightColors, darkColors])('colors Dart rows and finds text across token boundaries', colors => {
  palette = colors;
  const page = render(<TextDocumentPreview fileName="main.DART" text={"/* hi\r\nbye */\r\nfinal n = 'value';"} />);
  const color = (value: string) => {
    const span = document.createElement('span');
    span.style.color = value;
    return span.style.color;
  };
  expect(page.getByText('bye */').style.color).toBe(color(colors.syntaxComment));
  expect(page.getByText('final').style.color).toBe(color(colors.syntaxKeyword));
  expect(page.getByText("'value'").style.color).toBe(color(colors.syntaxString));
  fireEvent.click(page.getByText('message.attachmentPreview.find'));
  fireEvent.change(page.getByRole('textbox'), { target: { value: 'FINAL N' } });
  expect(page.getByText('1/1')).toBeTruthy();
  expect(page.getByText('final').closest('[data-selectable]')?.textContent).toBe("final n = 'value';");
});

it.each([
  ['source.unknown', 'final n = 1;'],
  ['source.dart', Array(7).fill('final n = 1;' + ' '.repeat(3000)).join('\n')],
])('keeps %s readable without syntax spans when highlighting is unavailable', (fileName, text) => {
  const page = render(<TextDocumentPreview fileName={fileName} text={text} />);
  const rows = Array.from(page.container.querySelectorAll('[data-selectable]'));
  expect(rows.map(row => row.textContent).join('\n')).toBe(text);
  expect(rows.every(row => row.childElementCount === 0)).toBe(true);
});
