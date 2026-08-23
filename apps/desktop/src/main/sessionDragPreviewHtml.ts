import type { SessionDragPreviewPalette } from '../shared/sessionDragPreview.js';
import { parseCssColor } from '../shared/theme-import/color.js';

const MAX_COLOR_LENGTH = 128;
const UNSAFE_STYLE_CHARACTERS = /[\u0000-\u001f\u007f&"'<>;*\\]/;
const SUPPORTED_COLOR_LITERAL = /^(?:#?[0-9a-f]{3,8}|(?:rgba?|hsla?)\([0-9a-z+.,%/\s-]+\))$/i;

export function truncateSessionDragPreviewLabel(value: string, maxCodePoints = 160): string {
  return Array.from(value).slice(0, maxCodePoints).join('');
}

function parsePaletteColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_COLOR_LENGTH ||
    UNSAFE_STYLE_CHARACTERS.test(trimmed) ||
    !SUPPORTED_COLOR_LITERAL.test(trimmed) ||
    parseCssColor(trimmed) === null
  ) {
    return null;
  }
  return trimmed;
}

export function parseSessionDragPreviewPalette(input: unknown): SessionDragPreviewPalette | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const surface = parsePaletteColor(record.surface);
  const border = parsePaletteColor(record.border);
  const text = parsePaletteColor(record.text);
  return surface && border && text ? { surface, border, text } : null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character] ?? character,
  );
}

export function buildSessionDragPreviewHtml(
  labelInput: string,
  paletteInput: SessionDragPreviewPalette,
): string {
  const label = escapeHtml(labelInput.trim());
  const palette = parseSessionDragPreviewPalette(paletteInput);
  if (!palette) throw new TypeError('Invalid session drag preview palette');
  const openWindowIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="display:block"><path d="M15 3h6v6M21 3l-9 9M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden;-webkit-font-smoothing:antialiased"><div style="box-sizing:border-box;display:flex;align-items:center;gap:9px;position:absolute;inset:8px;overflow:hidden;border:1px solid ${palette.border};border-radius:13px;background:${palette.surface};padding:0 12px 0 9px;color:${palette.text};font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:500;line-height:1.3"><span style="box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;color:${palette.text}">${openWindowIcon}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span></div></body></html>`;
}
