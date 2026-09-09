import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMobileMessageWebViewMetrics,
  registerMobileMessageWebView,
  resetMobileMessageWebViewMetrics,
} from '@/session/mobileMessageWebViewMetrics';

describe('mobile message WebView lifecycle accounting', () => {
  beforeEach(() => resetMobileMessageWebViewMetrics());

  it('counts active instances by kind and makes cleanup idempotent', () => {
    const releaseMermaid = registerMobileMessageWebView('mermaid');
    const releaseMath = registerMobileMessageWebView('math');

    expect(getMobileMessageWebViewMetrics()).toMatchObject({
      mounted: 2,
      mountedByKind: { mermaid: 1, math: 1, media: 0, composer: 0 },
      mounts: 2,
      unmounts: 0,
    });

    releaseMermaid();
    releaseMermaid();
    releaseMath();
    expect(getMobileMessageWebViewMetrics()).toMatchObject({
      mounted: 0,
      mountedByKind: { mermaid: 0, math: 0, media: 0, composer: 0 },
      mounts: 2,
      unmounts: 2,
    });
  });
});

describe('message WebView visibility wiring', () => {
  it('gates heavy message blocks without changing the list virtualization contract', () => {
    const renderer = readFileSync(
      resolve(process.cwd(), 'src/session/MessageRenderer.tsx'),
      'utf8',
    );
    const mermaid = readFileSync(resolve(process.cwd(), 'src/session/mermaidWebView.tsx'), 'utf8');
    const math = readFileSync(resolve(process.cwd(), 'src/session/mathWebView.tsx'), 'utf8');
    const media = readFileSync(resolve(process.cwd(), 'src/session/mediaPlayerWebView.tsx'), 'utf8');
    const composer = readFileSync(resolve(process.cwd(), 'src/session/ComposerRichInput.tsx'), 'utf8');

    expect(renderer).not.toContain('MessageListVisibleKeysContext');
    expect(renderer).toContain('useViewability<MobileMessageRenderItem>(');
    expect(renderer).toContain('const heavyContentVisible = focused || isViewable;');
    expect(renderer).toContain('function ViewabilityGatedMermaidDiagram(');
    expect(renderer).toContain('function ViewabilityGatedMathFormula(');
    expect(renderer).toContain('active={heavyContentVisible}');
    const markdownBodyStart = renderer.indexOf('function MarkdownBody(');
    const markdownBodyEnd = renderer.indexOf('\nfunction ', markdownBodyStart + 1);
    const markdownBody = renderer.slice(markdownBodyStart, markdownBodyEnd);
    expect(markdownBody).not.toContain('useContext(MessageHeavyContentVisibilityContext)');
    expect(renderer).toContain('getWebViewMetrics: getMobileMessageWebViewMetrics');
    expect(renderer).toContain('getMarkdownMetrics: getMobileMarkdownRenderMetrics');
    expect(renderer).toContain('devRecycleItems = false,');
    expect(renderer).toContain('const recycleItems = __DEV__ ? devRecycleItems === true : false;');
    expect(renderer).toContain('recycleItems={recycleItems}');
    expect(renderer).toContain('getItemType={mobileMessageListItemType}');
    expect(mermaid).toContain('active?: boolean;');
    expect(mermaid).toMatch(/active\s*\?\s*<WebView/);
    expect(math).toContain('active?: boolean;');
    expect(math).toMatch(/active\s*\?\s*<WebView/);
    expect(math).toContain('renderGenerationRef.current !== renderGeneration');
    expect(mermaid).toContain('pendingExportsRef.current.clear();');
    expect(mermaid).toContain('}, [active, source]);');
    expect(media).toContain('stopPlaybackAndLoading');
    expect(media).toContain('webViewRef.current?.stopLoading();');
    expect(media).toContain('lifecycleRef.current.consumeReloadOnActive()');
    expect(media).toContain('key={reloadGeneration}');
    expect(media).toContain('if (!mountedRef.current) return;');
    expect(composer).toContain('if (disposedRef.current) return;');
  });
});
