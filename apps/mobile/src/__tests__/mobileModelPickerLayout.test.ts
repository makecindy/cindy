/**
 * Mobile model-picker row layout contract.
 *
 * React Native components cannot load in the Node Vitest environment, so this test locks the
 * source structure that keeps secondary metadata from consuming the model-name line.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/session/MobileModelPickerList.tsx'),
  'utf8',
).replace(/\s+/g, ' ');

describe('MobileModelPickerList compact rows', () => {
  it('gives provider-aware model names a dedicated primary line', () => {
    const modelName = source.indexOf('{row.model.displayName}');
    const metadata = source.indexOf(
      '{isSubscription || rowEffort || fastOn ? (',
      modelName,
    );

    expect(modelName).toBeGreaterThan(-1);
    expect(metadata).toBeGreaterThan(modelName);
    expect(source.slice(modelName, metadata)).toContain('</View>');
  });

  it('keeps subscription, effort and Fast in the secondary line', () => {
    expect(source).toContain('<View style={styles.optionMetaRow}>');
    expect(source).toMatch(
      /\{t\(["']models\.picker\.subscriptionBadgeCompact["']\)\}/,
    );
    expect(source).toContain('{compactEffortLabelFor(');
    expect(source).toContain('{fastOn ? (');
    expect(source.match(/accessibilityLabel=\{rowAccessibilityLabel\}/g)).toHaveLength(2);
  });

  it('uses the same primary and secondary hierarchy for flat fallback rows', () => {
    const modelName = source.indexOf('{option.label}');
    const metadata = source.indexOf(
      '{rowEffort || (fastEditable && selected && selectedFastMode) ? (',
      modelName,
    );

    expect(modelName).toBeGreaterThan(-1);
    expect(metadata).toBeGreaterThan(modelName);
    expect(source.slice(modelName, metadata)).toContain('</View>');
  });
});
