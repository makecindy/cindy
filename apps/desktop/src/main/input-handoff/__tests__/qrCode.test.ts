import { describe, expect, it, vi } from 'vitest';
import { qrContent } from '../qrCode.js';

vi.mock('electron', () => ({ app: {}, nativeImage: {}, screen: {}, systemPreferences: {} }));
const { pickQr, qrCrop } = await import('../windowCapture.js');

describe('代输入 QR code', () => {
  it('offers web and app links to open, and anything else as text only', () => {
    expect(qrContent(' https://login.example.com/qr?t=1 ')).toEqual({ text: 'https://login.example.com/qr?t=1', url: 'https://login.example.com/qr?t=1' });
    for (const text of ['http://login.example.com/qr', 'https://printer.local/pair', 'weixin://dl/login?t=1'])
      expect(qrContent(text)).toEqual({ text, url: text });
    for (const text of ['https://user:pass@login.example.com/', 'javascript://x%0Aalert(1)', 'WIFI:S:home;T:WPA;P:secret;;'])
      expect(qrContent(text)).toEqual({ text });
    expect(qrContent('')).toBeNull();
    expect(qrContent('a\u0007b')).toBeNull();
    expect(qrContent('x'.repeat(2049))).toBeNull();
  });

  it('cuts the code out with a quiet zone, inside the picture', () => {
    expect(qrCrop([0.5, 0.25, 0.2, 0.2], { width: 1000, height: 1000 })).toEqual({ x: 476, y: 226, width: 248, height: 248 });
    // A code at the edge keeps what is there.
    expect(qrCrop([0, 0, 0.3, 0.3], { width: 1000, height: 1000 })).toEqual({ x: 0, y: 0, width: 336, height: 336 });
    expect(qrCrop([0.5, 0.5, 0, 0.2], { width: 1000, height: 1000 })).toBeNull();
    expect(qrCrop([0.5, 0.5, 0.001, 0.001], { width: 1000, height: 1000 })).toBeNull();
  });

  it('picks the largest code when a window shows several', () => {
    const small = { text: 'small', box: [0, 0, 0.1, 0.1] };
    const large = { text: 'large', box: [0.4, 0.4, 0.3, 0.3] };
    expect(pickQr([small, large])?.text).toBe('large');
    expect(pickQr([])).toBeNull();
  });
});
