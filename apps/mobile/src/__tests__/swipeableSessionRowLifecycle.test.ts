import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/session/SwipeableSessionRow.tsx'),
  'utf8',
);

describe('SwipeableSessionRow native animation lifecycle', () => {
  it('uses the classic RNGH Swipeable instead of Reanimated synchronous UI props', () => {
    expect(source).toContain('ClassicSwipeable as Swipeable');
    expect(source).not.toContain('ReanimatedSwipeable as Swipeable');
    expect(source).not.toContain("from 'react-native-reanimated'");
  });

  it('reads the release position instead of a peak and disposes Animated listeners', () => {
    expect(source).toContain('const value = translationRef.current?.__getValue?.();');
    expect(source).toContain('const releaseTranslation = readReleaseTranslation();');
    expect(source).not.toContain('peakTranslationRef');
    expect(source).toContain('translation.removeListener(listenerId)');
    expect(source).toContain('armedProgress.stopAnimation();');
  });

  it('keeps only fixed action shells mounted until a swipe starts', () => {
    expect(source).toContain('const [mountedActionRowKey, setMountedActionRowKey] = useState<string | null>(null);');
    expect(source).toContain('const actionsMounted = mountedActionRowKey === rowKey;');
    expect(source).toContain('setMountedActionRowKey(rowKey);');
    expect(source).toContain('setMountedActionRowKey(null);');
    expect(source).toContain('{actionsMounted ? (');
    expect(source).toContain('<View style={styles.pinShell}>');
    expect(source).toContain('<View style={styles.rightShell}>');
  });

  it('keeps the two right-side action buttons evenly spaced', () => {
    expect(source).toMatch(/optionsButton:\s*\{[\s\S]*?right: BUTTON_GAP \* 2 \+ BUTTON_SIZE,/);
    expect(source).toMatch(/archiveButton:\s*\{[\s\S]*?right: BUTTON_GAP,/);
  });
});
