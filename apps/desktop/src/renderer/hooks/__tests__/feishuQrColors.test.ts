import * as QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';

import { toQrColors } from '../useFeishuBotRegistration';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('Feishu registration QR colors', () => {
  it('turns Cindy translucent ink into the opaque hex that qrcode accepts', async () => {
    // Cindy Light: --settings-section-title resolves to the 88% black ink text tier.
    const colors = toQrColors('rgba(0, 0, 0, 0.88)', '#FCFCFC');
    expect(colors).toEqual({ dark: '#1e1e1e', light: '#fcfcfc' });
    await expect(QRCode.toDataURL('https://example.com', { color: colors })).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('falls back to black modules on white when a theme color cannot be read', () => {
    expect(toQrColors('', '')).toEqual({ dark: '#000000', light: '#ffffff' });
  });
});
