/**
 * transportText.test.ts — 传输层用户可见文案的多语言注入口。
 * 钉死:无 resolver / resolver 不认识 key / resolver 抛错时都落回内置中文(包可独立运行);
 * 装上英文 resolver 后,文案在发送时现取英文并填好 {{变量}};传输层用到的每个 key
 * 都在桌面端词库里(zh-CN + en)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../feishu/messages.js';
import { setTransportTextResolver, tt, type TransportTextVars } from '../transportText.js';
import { stripXdtForStreaming } from '../xdtRefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const localesRoot = path.resolve(here, '../../../../apps/desktop/src/renderer/i18n/locales');
const hasDesktopLocales = fs.existsSync(path.join(localesRoot, 'en', 'common.json'));

function loadCatalogue(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localesRoot, locale, 'common.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function lookup(bundle: Record<string, unknown>, key: string): string | null {
  let cur: unknown = bundle;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/** Same contract as the desktop resolver: plural by `count`, fill `{{var}}`, null when missing. */
function catalogueResolver(locale: string) {
  const bundle = loadCatalogue(locale);
  return (key: string, vars?: TransportTextVars): string | null => {
    const count = vars?.count;
    const raw =
      typeof count === 'number'
        ? (lookup(bundle, `${key}_${new Intl.PluralRules(locale).select(count)}`) ??
          lookup(bundle, `${key}_other`))
        : lookup(bundle, key);
    if (raw === null) return null;
    return raw.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
      vars && vars[name] !== undefined ? String(vars[name]) : match,
    );
  };
}

afterEach(() => {
  setTransportTextResolver(null);
  vi.restoreAllMocks();
});

describe('tt fallback', () => {
  it('uses the built-in Chinese copy when no resolver is installed', () => {
    expect(messages.lifecycle.online).toBe('🟢 已上线，可以开聊啦~');
    expect(messages.streaming.partNote(1, 3)).toBe('1/3 · 未完，接下一条');
    expect(messages.streaming.fileSentDone(4)).toBe('🎉 4 个文件已全部送达 ~');
  });

  it('falls back (with variables filled) when the resolver does not know the key', () => {
    setTransportTextResolver(() => null);
    expect(tt('imBot.text.transport.test.missing', '共 {{count}} 个，最多 {{max}} 个', { count: 3, max: 4 })).toBe(
      '共 3 个，最多 4 个',
    );
    expect(messages.connection.authFailed).toBe('App ID 或 App Secret 不正确');
  });

  it('falls back when the resolver throws', () => {
    setTransportTextResolver(() => {
      throw new Error('catalogue not ready');
    });
    expect(messages.card.choiceReceived).toBe('已收到您的选择');
  });

  it('keeps the bilingual stranger notice regardless of the resolver', () => {
    setTransportTextResolver(() => 'resolved');
    expect(messages.group.strangerNotice).toContain('I am a personal Cindy assistant');
  });
});

describe.skipIf(!hasDesktopLocales)('English resolver', () => {
  it('resolves copy at send time and interpolates variables', () => {
    expect(messages.lifecycle.offlineNotice).toContain('我之前离线过');

    setTransportTextResolver(catalogueResolver('en'));
    expect(messages.lifecycle.online).toBe("🟢 I'm online. Let's talk!");
    expect(messages.streaming.partNote(2, 3)).toBe('2/3 · continued in next message');
    expect(messages.streaming.partNote(3, 3)).toBe('3/3 · end');
    expect(messages.streaming.fileSentDone(1)).toBe('🎉 Your file is here!');
    expect(messages.streaming.fileSentDone(3)).toBe('🎉 All 3 files delivered~');
    expect(messages.connection.conflict).toContain('exceed_conn_limit');
    expect(stripXdtForStreaming('![](xdt-image://feishu-media-images/a.png)')).toBe('[🖼️ Image · Uploading…]');
    expect(stripXdtForStreaming('[report.pdf](xdt-file:///tmp/report.pdf)')).toBe(
      '[📎 report.pdf · Preparing to send…]',
    );

    // A language switch takes effect on the very next lookup.
    setTransportTextResolver(null);
    expect(messages.lifecycle.online).toBe('🟢 已上线，可以开聊啦~');
  });

  it('keeps the non-final part note longer than the final one (card splitting reserves for it)', () => {
    for (const locale of ['zh-CN', 'en', 'de', 'fr', 'ja']) {
      setTransportTextResolver(catalogueResolver(locale));
      expect(messages.streaming.partNote(98, 99).length).toBeGreaterThan(
        messages.streaming.partNote(99, 99).length,
      );
    }
  });

  it('every transport key used by the package exists in the zh-CN and en catalogues', () => {
    const requested = new Set<string>();
    setTransportTextResolver((key) => {
      requested.add(key);
      return null;
    });
    // Keys built dynamically: every thinking variant.
    for (let i = 0; i < 12; i += 1) {
      vi.spyOn(Math, 'random').mockReturnValueOnce((i + 0.5) / 12);
      messages.streaming.randomThinking();
    }
    // Keys written literally in the sources.
    const K = 'imBot.text.transport.feishu';
    const literal = /['"`](imBot\.text\.transport\.[\w.]+|\$\{K\}\.[\w.]+)['"`]/g;
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
      });
    for (const file of walk(srcRoot)) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(literal)) {
        // `const K = 'imBot.text.transport.feishu'` is a prefix, not a key.
        if (match[1] !== K) requested.add(match[1].replace('${K}', K));
      }
    }
    expect(requested.size).toBeGreaterThan(40);

    for (const locale of ['zh-CN', 'en']) {
      const bundle = loadCatalogue(locale);
      const missing = [...requested].filter(
        (key) => lookup(bundle, key) === null && lookup(bundle, `${key}_other`) === null,
      );
      expect(missing, locale).toEqual([]);
    }
  });
});
