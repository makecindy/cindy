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
  it('gives provider-aware model names a dedicated primary line above the meta line', () => {
    const modelName = source.indexOf('{row.model.displayName}');
    const metadata = source.indexOf('{metaLine ? (', modelName);

    expect(modelName).toBeGreaterThan(-1);
    expect(metadata).toBeGreaterThan(modelName);
    expect(source.slice(modelName, metadata)).toContain('</Text>');
  });

  it('keeps subscription, effort and Fast in one secondary line like iOS', () => {
    expect(source).toContain("isSubscription ? t('models.picker.subscriptionBadge') : null,");
    expect(source).toContain('fullEffortLabel,');
    expect(source).toContain("fastOn ? t('models.options.fastMode') : null,");
    expect(source).toContain(".join(' · ');");
    expect(source.match(/accessibilityLabel=\{rowAccessibilityLabel\}/g)).toHaveLength(2);
    // 选中只用勾号表达,不再铺整行底色。
    expect(source).not.toContain('optionRowSelected');
  });

  it('groups provider rows by source with a source · account title', () => {
    expect(source).toContain('groups.set(row.provider.id, rows);');
    expect(source).toContain("identity && !provider.name.includes(identity) ? identity : null,");
    expect(source).toContain('style={styles.groupLabel}>{groupTitle}</Text>');
  });

  it('uses the same primary and secondary hierarchy for flat fallback rows', () => {
    const modelName = source.indexOf('{option.label}');
    const metadata = source.indexOf('{metaLine ? (', modelName);

    expect(modelName).toBeGreaterThan(-1);
    expect(metadata).toBeGreaterThan(modelName);
    expect(source.slice(modelName, metadata)).toContain('</Text>');
  });
});
