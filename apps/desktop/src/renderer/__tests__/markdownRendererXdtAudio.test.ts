/**
 * markdownRendererXdtAudio.test.ts
 * ---------------------------------------------------------------------------
 * Source-contract regression test for chat-audio-inline-playback.
 *
 * `MarkdownRenderer.tsx` has two cooperating edits that together make
 * `xdt-audio://` markdown links render as inline `<audio>` players in
 * the chat bubble. Either edit alone is silently broken: removing the
 * urlTransform allowlist makes react-markdown's defaultUrlTransform
 * sanitize the href to "" (audio loses src, controls show as broken);
 * removing the `<a>` audio branch reverts to a plain link that opens
 * the file externally via openExternal. Both regressions would pass
 * normal unit tests because the renderer is harness-mounted with React
 * and we don't have a JSDom snapshot. This test grep-anchors the source
 * so the contract can't drift unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(
  __dirname,
  '..',
  'components',
  'chat',
  'MarkdownRenderer.tsx',
);
const source = readFileSync(sourcePath, 'utf8');

// ── 改动 1: urlTransform 白名单透传 xdt-audio:// ─────────────────────────

describe('MarkdownRenderer — urlTransform allows xdt-audio://', () => {
  it("urlTransform whitelists 'xdt-audio://' (else react-markdown sanitizes href to empty)", () => {
    expect(source).toContain("url.startsWith('xdt-audio://')");
  });
});

// ── 改动 2: <a> 渲染分支识别 xdt-audio:// → <audio controls> ─────────────

describe('MarkdownRenderer — <a> renderer routes xdt-audio:// to <audio>', () => {
  const linkComponentMatch = source.match(
    /function MarkdownTargetLink\([\s\S]*?function InlineCodeWithTarget/,
  );

  it('routes audio through the unified markdown target classifier', () => {
    expect(linkComponentMatch).not.toBeNull();
    const branch = linkComponentMatch![0];
    expect(branch).toContain("target.kind === 'audio'");
    // The validated audio source still goes through the source-device rewrite.
    // Pending/SSH rejection and recovery run through the real DOM regression
    // in markdownVideoRenderer.test.tsx; this existing guard checks the wiring.
    expect(branch).toContain('<InlineXdtAudioPlayer src={rewriteToRemoteMediaOrigin(normalized, remoteMediaOrigin)} />');
  });

  it('renders <audio controls> with preload="metadata" controlsList="nodownload" src={href}', () => {
    const playerMatch = source.match(/function InlineXdtAudioPlayer[\s\S]*?function LightboxImage/);
    expect(playerMatch).not.toBeNull();
    const player = playerMatch![0];
    expect(player).toContain('<audio');
    expect(player).toContain('controls');
    expect(player).toContain('preload="metadata"');
    expect(player).toContain('controlsList="nodownload"');
    expect(player).toContain('src={src}');
  });

  it('does NOT set autoplay / loop (avoid surprise sound, chromium blocks audio autoplay anyway)', () => {
    const playerMatch = source.match(/function InlineXdtAudioPlayer[\s\S]*?function LightboxImage/);
    expect(playerMatch).not.toBeNull();
    const player = playerMatch![0];
    expect(player).not.toContain('autoplay');
    expect(player).not.toContain('loop');
  });

  it('does NOT set a React key (mdast node identity stabilises children; key={href} would warn on legitimate URL repeats)', () => {
    const playerMatch = source.match(/function InlineXdtAudioPlayer[\s\S]*?function LightboxImage/);
    expect(playerMatch).not.toBeNull();
    const player = playerMatch![0];
    expect(player).not.toMatch(/\bkey=/);
  });
});
