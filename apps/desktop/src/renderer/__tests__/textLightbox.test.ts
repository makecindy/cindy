/**
 * textLightbox.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for: text-lightbox (2026-04-19)
 *
 * The component lives at components/chat/TextLightbox.tsx. Static-source
 * scanning matches the project convention (see imageLightboxCloseAnywhere.test.ts
 * and userInfoSectionHover.test.ts) — keeps tests in the Node vitest env
 * and avoids dragging in jsdom + react-dom for these contract checks.
 *
 * Contracts asserted:
 *   F3  Overlay backdrop uses --overlay-lightbox (rgba(0,0,0,0.85)).
 *   F4  Toolbar copies file path on filename click; copies content on Copy btn;
 *       Toolbar shows ONLY Copy + Close (no ExternalLink) — Open-in-System
 *       moved exclusively to the Oversize CTA after the file-modal-and-toast
 *       polish on 2026-04-19.
 *   F4  Toolbar Close (X) button wires to handleClose.
 *   F4  Doc Card sized at 80vw/80vh capped 1600/1200 (no longer 1024×640).
 *   F5  Oversize body shows triangle-alert + i18n 阈值文案 + Open-in-system CTA
 *       (Oversize is the SOLE caller of window.electronAPI.openPath now).
 *   F6  Esc closes; Doc Card clicks stop propagation; Overlay onClick=handleClose
 *   F6  handleClose is idempotent via isClosingRef
 *   General: scroll-lock targets the same [data-scroll-container] selector
 *            ImageLightbox uses (parity).
 *   formatBytes: known sizes round-trip to the spec's "<n> <unit>" format.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatBytes } from '../components/chat/TextLightbox';
import { detectRenderable, buildFence } from '../lib/textPreview';

const sourcePath = resolve(__dirname, '..', 'components', 'chat', 'TextLightbox.tsx');
const source = readFileSync(sourcePath, 'utf8');
const colorsPath = resolve(__dirname, '..', 'themes', 'colors.ts');
const colorsSource = readFileSync(colorsPath, 'utf8');
const localePath = resolve(__dirname, '..', 'i18n', 'locales', 'zh-CN', 'common.json');
const locale = JSON.parse(readFileSync(localePath, 'utf8')) as {
  chat: {
    textLightbox: {
      loading: string;
      oversizeTitle: string;
      oversizeBody: string;
      openInSystem: string;
      closeHint: string;
    };
  };
};

// ── F6: close behaviour ────────────────────────────────────────────────────

describe('TextLightbox — F6 close behaviour', () => {
  it('Esc key calls handleClose', () => {
    expect(source).toMatch(/e\.key\s*===\s*'Escape'/);
    expect(source).toMatch(/handleClose\(\)/);
  });

  it('backdrop button wires onClick to handleClose (backdrop click closes)', () => {
    expect(source).toMatch(/<button[\s\S]*type="button"[\s\S]*aria-label=\{t\('chat\.lightbox\.close'\)\}/);
    expect(source).toMatch(/onClick=\{handleClose\}/);
  });

  it('Doc Card is layered above the backdrop button so inner clicks DO NOT close', () => {
    // The backdrop close target is a separate background button behind the Doc
    // Card. Toolbar buttons and text selection stay on the higher card layer.
    expect(source).toMatch(/data-text-lightbox-card/);
    expect(source).toContain('backdrop is a separate background button behind the Doc Card');
    expect(source).toMatch(/zIndex:\s*1/);
  });

  it('handleClose guards against double-fire via isClosingRef', () => {
    expect(source).toContain('isClosingRef.current');
    expect(source).toMatch(/if\s*\(isClosingRef\.current\)\s*return;/);
  });
});

// ── F3: overlay style parity ────────────────────────────────────────────────

describe('TextLightbox — F3 overlay style', () => {
  it('overlay background uses the lightbox overlay theme token', () => {
    // overlay 已迁到主题 token,避免组件内写死 rgba 颜色。
    expect(source).toContain("background: 'var(--overlay-lightbox)'");
    expect(colorsSource).toMatch(
      /registerColor\('overlay-lightbox'[\s\S]*light:\s*'rgba\(0, 0, 0, 0\.85\)'[\s\S]*dark:\s*'rgba\(0, 0, 0, 0\.85\)'/,
    );
  });

  it('overlay is rendered via createPortal to document.body', () => {
    expect(source).toMatch(/createPortal\(overlay,\s*document\.body\)/);
  });

  it('keeps every toolbar tooltip above the lightbox overlay', () => {
    expect(source).toMatch(/TEXT_LIGHTBOX_OVERLAY_Z_INDEX\s*=\s*9999/);
    expect(source).toMatch(
      /TEXT_LIGHTBOX_TOOLTIP_STYLE\s*=\s*\{[\s\S]*zIndex:\s*TEXT_LIGHTBOX_OVERLAY_Z_INDEX\s*\+\s*1/,
    );

    const tooltipContents = source.match(/<Tooltip\.Content\b/g) ?? [];
    const layeredTooltipContents =
      source.match(/<Tooltip\.Content\s+style=\{TEXT_LIGHTBOX_TOOLTIP_STYLE\}/g) ?? [];
    expect(tooltipContents.length).toBeGreaterThan(0);
    expect(layeredTooltipContents).toHaveLength(tooltipContents.length);
  });
});

// ── F4: toolbar wiring ──────────────────────────────────────────────────────

describe('TextLightbox — F4 toolbar wiring', () => {
  it('clicking the filename copies the FULL file path to clipboard', () => {
    // The 三段式 toolbar contract: filename click → copy path; the dedicated
    // Copy button → copy content. Symmetry must not be broken.
    expect(source).toMatch(/copyPath/);
    expect(source).toMatch(/navigator\.clipboard\.writeText\(filePath\)/);
  });

  it('Copy button writes file CONTENT, not the path', () => {
    expect(source).toMatch(/copyContent/);
    expect(source).toMatch(/navigator\.clipboard\.writeText\(loadState\.content\)/);
  });

  it('Open in System routes through window.electronAPI.openPath', () => {
    // Renderer never touches `electron` or `fs` — must go through the IPC
    // bridge. This pins the contract so a future commit cannot quietly
    // import shell or fs from renderer code. (Now invoked exclusively from
    // the Oversize CTA after the 2026-04-19 polish.)
    // remote 会话对缓存副本操作:openInSystem 的目标按 origin 分流(远程 = cachePath)。
    expect(source).toMatch(/window\.electronAPI\.openPath\(target\)/);
    expect(source).toMatch(/remoteOrigin \? remoteCopy\?\.cachePath : filePath/);
  });

  it('Copy button is disabled until file content is loaded', () => {
    // Until the read returns successfully (loadState.phase === 'ready'),
    // there is nothing meaningful to copy.
    expect(source).toMatch(/disabled=\{loadState\.phase\s*!==\s*'ready'\}/);
  });

  it('Toolbar no longer renders the ExternalLink button (2026-04-19 polish)', () => {
    // The Toolbar previously held three buttons (ExternalLink + Copy + …).
    // After the file-modal-and-toast polish only Copy + Close remain on the
    // right; ExternalLink is exclusively used inside the Oversize CTA. So
    // the source still imports/uses ExternalLink (Oversize CTA), but it must
    // not appear inside the Toolbar wiring (= no `onClick={openInSystem}` on
    // a Toolbar button — only on the Oversize CTA).
    const openInSystemMatches = source.match(/onClick=\{openInSystem\}/g) ?? [];
    expect(openInSystemMatches.length).toBe(1);
  });

  it('Toolbar adds an X close button wired to handleClose', () => {
    // The new affordance — a visible × button on the Toolbar's right side
    // gives users a third escape hatch (besides Esc and backdrop click).
    expect(source).toMatch(/import\s+\{[^}]*\bX\b[^}]*\}\s+from\s+'lucide-react'/);
    // Two `onClick={handleClose}` are now expected: overlay backdrop + Toolbar X.
    const handleCloseClicks = source.match(/onClick=\{handleClose\}/g) ?? [];
    expect(handleCloseClicks.length).toBeGreaterThanOrEqual(2);
  });

  it('Doc Card sizes to 80vw/80vh with 1600/1200 caps (post-polish)', () => {
    // Old hard-coded `min(1024px, …)` caused the modal to feel small + offset.
    // Polish picks the design-spec 80%/80% with sane upper bounds for 4K/5K.
    expect(source).toMatch(/width:\s*'80vw'/);
    expect(source).toMatch(/height:\s*'80vh'/);
    expect(source).toMatch(/maxWidth:\s*'1600px'/);
    expect(source).toMatch(/maxHeight:\s*'1200px'/);
    // And explicitly NOT the old hard-coded 1024 / 640 values.
    expect(source).not.toMatch(/min\(1024px/);
    expect(source).not.toMatch(/min\(640px/);
  });
});

// ── F5: Oversize body ───────────────────────────────────────────────────────

describe('TextLightbox — F5 Oversize body', () => {
  it('uses TriangleAlert as the Oversize icon (lucide new naming)', () => {
    expect(source).toMatch(/import\s+\{[^}]*TriangleAlert[^}]*\}\s+from\s+'lucide-react'/);
  });

  it('uses i18n copy with dynamic file size and the preview cap', () => {
    // 文案必须通过 i18n 注入动态 size/limit，组件内不再保留英文裸文案。
    expect(source).toContain("t('chat.textLightbox.oversizeTitle')");
    expect(source).toContain(
      "t('chat.textLightbox.oversizeBody', { size: oversizeSizeText, limit: oversizeLimitMb })",
    );
    expect(source).not.toMatch(
      /This file is \{oversizeSizeText\}, exceeding the \{oversizeLimitMb\} MB preview limit/,
    );
    expect(locale.chat.textLightbox.oversizeTitle).toBe('文件过大，无法预览');
    expect(locale.chat.textLightbox.oversizeBody).toBe(
      '该文件大小为 {{size}}，超过 {{limit}}MB 预览上限。请使用系统默认应用打开。',
    );
  });

  it('exposes a 10 MB OVERSIZE_LIMIT constant (decision: lower from 30 → 10)', () => {
    // Threshold lives in the renderer module; main process mirrors it via
    // the `limitMb` IPC field. Source-level assertion catches accidental
    // regressions on either constant.
    expect(source).toMatch(/OVERSIZE_LIMIT_MB\s*=\s*10/);
    expect(source).toMatch(/OVERSIZE_LIMIT\s*=\s*OVERSIZE_LIMIT_MB\s*\*\s*1024\s*\*\s*1024/);
  });

  it('reads the IPC limitMb field instead of hard-coding the cap', () => {
    // The Loading useEffect must thread `res.limitMb` into the oversize
    // state so dynamic copy ("exceeding the {limitMb} MB preview limit")
    // reflects the main-process cap, not a renderer-local magic number.
    expect(source).toMatch(/limitMb:\s*res\.limitMb\s*\?\?\s*OVERSIZE_LIMIT_MB/);
  });

  it('Oversize CTA opens the file via openPath (not openExternal)', () => {
    // The CTA must call `openInSystem`, which is the wrapper around
    // electronAPI.openPath. After the 2026-04-19 polish there is exactly
    // ONE onClick={openInSystem} usage left (the Oversize CTA) — the Toolbar
    // button was removed.
    const matches = source.match(/onClick=\{openInSystem\}/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('Oversize CTA pill uses --lightbox-cta-* tokens (no hard-coded #000000)', () => {
    // Dark Oversize button must be visible on Dark Card (#2c2c2a) — that
    // means the pill cannot keep the prior `bg-[#000000]` hard-code; both
    // light and dark backgrounds need to flip together via tokens.
    expect(source).toMatch(/bg-\[var\(--lightbox-cta-bg\)\]/);
    expect(source).toMatch(/text-\[var\(--lightbox-cta-fg\)\]/);
    expect(source).toMatch(/hover:bg-\[var\(--lightbox-cta-hover\)\]/);
    // Negative assertion: the old hard-coded black must not regress.
    expect(source).not.toMatch(/bg-\[#000000\]/);
    expect(source).not.toMatch(/hover:bg-\[#262626\]/);
  });
});

// ── Loading state spinner + i18n copy ──────────────────────────────────────

describe('TextLightbox — Loading state', () => {
  it('renders the shared Spinner while loading', () => {
    // Spinner is the visual signal that the modal is alive while the IPC
    // resolves. The shared ui/spinner keeps the rotation on an HTML wrapper
    // (设计实现规范规则 7: SVG 上不挂 CSS 动画), the icon svg itself stays static.
    expect(source).toMatch(/import\s+\{[^}]*Spinner[^}]*\}\s+from\s+'@\/components\/ui\/spinner'/);
    expect(source).toMatch(/<Spinner[\s\S]*size=\{32\}/);
  });

  it('uses i18n loading copy', () => {
    // loading 文案同样走 i18n，避免四语言界面回退到英文裸文案。
    expect(source).toContain("t('chat.textLightbox.loading')");
    expect(source).not.toContain('Loading file...');
    expect(source).not.toContain('正在读取');
    expect(locale.chat.textLightbox.loading).toBe('正在加载文件…');
  });

  it('renders an em-dash placeholder in the toolbar size slot during loading', () => {
    // Without the placeholder the size segment width snaps when the read
    // resolves — design `PSTiX` uses "—" so the slot stays stable.
    expect(source).toMatch(/loadState\.phase\s*===\s*'loading'\s*\?\s*'—'/);
  });
});

// ── CodeMirror source preview ──────────────────────────────────────────────

describe('TextLightbox — CodeMirror source preview', () => {
  it('delegates text/code preview to PlaintextEditor instead of direct worker highlight', () => {
    // CodeMirror 自带 viewport 渲染、readOnly、line scroll 和大文件降级；
    // TextLightbox 只负责 modal chrome，不再维护一套手写虚拟滚动。
    expect(source).toMatch(/PlaintextEditor[\s\S]*PlaintextEditorHandle/);
    expect(source).not.toMatch(/new\s+Worker\(/);
    expect(source).not.toContain('HIGHLIGHT_WORKER_TIMEOUT_MS');
  });
});

// ── Scroll-lock parity with ImageLightbox ──────────────────────────────────

describe('TextLightbox — scroll lock parity', () => {
  it('targets [data-scroll-container] (same selector as ImageLightbox)', () => {
    expect(source).toMatch(/\[data-scroll-container\]/);
    expect(source).toMatch(/overflowY\s*=\s*'hidden'/);
  });
});

// ── formatBytes — pure function ─────────────────────────────────────────────

describe('TextLightbox — formatBytes', () => {
  it('formats sub-KB as bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(73)).toBe('73 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB with one decimal under 10, integer above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });

  it('formats MB with one decimal (matches spec example "23.4 MB")', () => {
    // 23.4 * 1024 * 1024 ≈ 24,536,678 bytes → "23.4 MB"
    expect(formatBytes(Math.round(23.4 * 1024 * 1024))).toBe('23.4 MB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('handles negative / NaN gracefully', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

// ── detectRenderable — file-type dispatch ──────────────────────────────────

describe('TextLightbox — detectRenderable', () => {
  it('routes Markdown extensions to the rich-text renderer', () => {
    expect(detectRenderable('/x/README.md')).toEqual({ kind: 'markdown' });
    expect(detectRenderable('a/b/notes.MARKDOWN')).toEqual({ kind: 'markdown' });
    expect(detectRenderable('post.mdx')).toEqual({ kind: 'markdown' });
  });

  it('routes common code extensions to highlighted code with the right hljs alias', () => {
    expect(detectRenderable('config.json')).toEqual({ kind: 'code', lang: 'json' });
    expect(detectRenderable('app.tsx')).toEqual({ kind: 'code', lang: 'typescript' });
    expect(detectRenderable('script.py')).toEqual({ kind: 'code', lang: 'python' });
    expect(detectRenderable('Main.go')).toEqual({ kind: 'code', lang: 'go' });
    // html/svg/vue all collapse to xml — that's how highlight.js's common
    // bundle ships them. Pin it so a refactor doesn't accidentally split them.
    expect(detectRenderable('index.html')).toEqual({ kind: 'code', lang: 'xml' });
  });

  it('matches Dockerfile / Makefile by filename (no extension)', () => {
    expect(detectRenderable('repo/Dockerfile')).toEqual({ kind: 'code', lang: 'dockerfile' });
    expect(detectRenderable('Makefile')).toEqual({ kind: 'code', lang: 'makefile' });
  });

  it('falls back to plain text for unknown extensions or no extension', () => {
    expect(detectRenderable('debug.log')).toEqual({ kind: 'text' });
    expect(detectRenderable('data.csv')).toEqual({ kind: 'text' });
    expect(detectRenderable('LICENSE')).toEqual({ kind: 'text' });
    expect(detectRenderable('.gitignore')).toEqual({ kind: 'text' });
  });
});

// ── fileParentDir — POSIX root boundary (reviewer Issue 1, 2026-04-19) ─────

describe('TextLightbox — fileParentDir POSIX root boundary', () => {
  it('preserves POSIX root semantics when filePath = "/x.md"', () => {
    // Reviewer-flagged regression: lastIndexOf('/') === 0 → slice(0,0) = ""
    // would lose the cwd root, so resolveLocalPath('foo.md', '') would compute
    // '' + '/' + 'foo.md' instead of '/foo.md'. The fix branches on idx===0
    // and returns '/' (or the leading drive char) explicitly. Source-level
    // assertion pins both the branch and the comment marker so a refactor
    // can't quietly drop the boundary handling.
    expect(source).toMatch(/POSIX root/i);
    // The new derivation must contain an idx===0 branch returning '/'.
    expect(source).toMatch(/idx\s*===\s*0/);
    expect(source).toMatch(/filePath\.startsWith\(\s*'\/'\s*\)\s*\?\s*'\/'/);
  });

  it('still falls back to filePath itself when there is no separator', () => {
    // Bare filename (no '/' or '\') → no parent dir to derive; the existing
    // behaviour returns the filePath as-is so resolveLocalPath stays defined.
    expect(source).toMatch(/if\s*\(idx\s*<\s*0\)\s*return\s+filePath;/);
  });
});

// ── buildFence — backtick-safe code block wrapper ──────────────────────────

describe('TextLightbox — buildFence', () => {
  it('uses a 3-backtick fence for content with no backticks', () => {
    const out = buildFence('const x = 1;', 'typescript');
    expect(out).toBe('```typescript\nconst x = 1;\n```');
  });

  it('lengthens the fence past the longest backtick run inside the source', () => {
    // Source contains a 3-backtick run → fence must be ≥4 backticks.
    const src = 'before\n```js\nfoo();\n```\nafter';
    const out = buildFence(src, 'markdown');
    expect(out.startsWith('````markdown\n')).toBe(true);
    expect(out.endsWith('\n````')).toBe(true);
    expect(out).toContain(src);
  });

  it('handles a 5-backtick run by emitting a 6-backtick fence', () => {
    const src = '`````';
    const out = buildFence(src, 'json');
    expect(out).toBe('``````json\n`````\n``````');
  });
});
