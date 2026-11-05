import { describe, expect, it } from 'vitest';
import { SETTINGS_SEARCH_ENTRIES } from '../settingsSearchCatalog';
import type { SettingsSearchEntry } from '../settingsSearchTypes';

const modules = import.meta.glob<Record<string, unknown>>('../**/*.settings-search.ts', {
  eager: true,
});

// Configuration contract: search anchors must exist across lazily mounted pages.
// Static checks live in guard tier; real delayed DOM navigation is tested separately.
// Rule: configuration-and-overrides.md §6. Missing target is the minimal failure;
// standalone local run: 3.51s wall time.
describe('settings search anchor contract', () => {
  it('points to existing anchors and covers every search anchor', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', {
      query: '?raw',
      eager: true,
      import: 'default',
    });
    Object.assign(
      sources,
      import.meta.glob<string>('../../../features/bots/BotsGlobalSettingsSection.tsx', {
        query: '?raw',
        eager: true,
        import: 'default',
      }),
    );
    const productionSources = Object.entries(sources)
      .filter(([path]) => !path.includes('__tests__') && !path.endsWith('/SettingsSearchBox.tsx'))
      .map(([, text]) => text);
    const source = productionSources.join();
    const targets = new Set(
      SETTINGS_SEARCH_ENTRIES.flatMap((entry) => [entry.targetId, entry.fallbackTargetId]),
    );
    const definitionTargets = new Set<string>();
    for (const text of productionSources) {
      const definitions = new Map<string, Record<string, SettingsSearchEntry>>();
      for (const imported of text.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+\.settings-search)['"]/g,
      )) {
        const filename = imported[2].split('/').at(-1) + '.ts';
        const namespace = Object.entries(modules).find(([path]) =>
          path.endsWith('/' + filename),
        )?.[1];
        for (const binding of imported[1].split(',')) {
          const [exported, local = exported] = binding.trim().split(/\s+as\s+/);
          if (namespace?.[exported])
            definitions.set(local, namespace[exported] as Record<string, SettingsSearchEntry>);
        }
      }
      for (const match of text.matchAll(/id=\{(\w+)\.(\w+)\.targetId\}/g)) {
        const definition = definitions.get(match[1])?.[match[2]];
        if (definition) definitionTargets.add(definition.targetId);
      }
      // Dynamic rows read the same imported collection as the catalog. Require
      // the selected definition's targetId to actually feed a rendered anchor.
      // Per-row identity and platform filtering are also checked against real DOM
      // in KeyboardShortcutsSection.mutationRace.test.tsx.
      for (const match of text.matchAll(/const (\w+) = (\w+)\[[^\]]+\];/g)) {
        if (!text.includes('id={' + match[1] + '.targetId}') &&
          !text.includes('id={' + match[1] + '?.targetId}')) continue;
        const collection = definitions.get(match[2]);
        if (!collection) continue;
        for (const definition of Object.values(collection)) {
          definitionTargets.add(definition.targetId);
        }
      }
      for (const match of text.matchAll(/const (\w+) = useSettingDefinition\(([\s\S]*?)\);/g)) {
        if (!text.includes('...' + match[1] + '.anchorProps')) continue;
        for (const reference of match[2].matchAll(/(\w+)\.(\w+)/g)) {
          const definition = definitions.get(reference[1])?.[reference[2]];
          if (definition) definitionTargets.add(definition.targetId);
        }
      }
    }
    for (const target of targets) {
      // The shared WeChat component selects its anchor at runtime. Its catalog target
      // and companion isolation are checked against real DOM in WechatBotSection.test.tsx.
      if (target === 'personal-im-wechat') continue;
      if (target) {
        const dynamicProviderAnchor =
          /^cindy-im-(slack|telegram|x)$/.test(target) &&
          source.includes('id={`cindy-im-${provider}`}');
        expect(
          source.includes('id="' + target + '"') ||
            dynamicProviderAnchor ||
            definitionTargets.has(target),
          target,
        ).toBe(true);
      }
    }
    for (const [, target] of source.matchAll(/id="(settings-search-[^"]+)"/g)) {
      expect(targets.has(target), target).toBe(true);
    }
  });
});
