import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import permissionCopy from './resources/mac-permission-locales.json';
import { modernLocaleOf, resolveSystemLocale } from './src/shared/locale';

/** Run before signing. Keep Electron's own locale resources and plist keys intact. */
export function stageMacPermissionLocales(resourcesPath: string): void {
  const targets = [resourcesPath];
  const frameworks = path.join(resourcesPath, '..', 'Frameworks');
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks, { withFileTypes: true })) {
      if (entry.isDirectory() && / Helper(?: \([^)]+\))?\.app$/.test(entry.name)) {
        targets.push(path.join(frameworks, entry.name, 'Contents', 'Resources'));
      }
    }
  }
  for (const target of targets) {
    const copies = new Map(Object.entries(permissionCopy));
    // Electron also ships regional directories (for example es_419 and pt_BR).
    // Keep their names/resources; OS language matching can select them directly.
    if (fs.existsSync(target)) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^(?:zh|en|ja|ko|es|fr|de|pt)(?:[-_][\w-]+)?\.lproj$/.test(entry.name)) continue;
        const tag = entry.name.slice(0, -'.lproj'.length);
        const resolved = modernLocaleOf(resolveSystemLocale(tag));
        const key = resolved === 'zh-CN' ? 'zh-Hans' : resolved === 'zh-TW' ? 'zh-Hant' : resolved;
        copies.set(tag, permissionCopy[key as keyof typeof permissionCopy]);
      }
    }
    for (const [locale, copy] of copies) {
      const dir = path.join(target, `${locale}.lproj`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'InfoPlist.strings');
      // A localized usage string does not grant a permission or add an Info.plist key.
      // Append overrides instead of replacing Electron's localized bundle names.
      const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe;
      const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
      const existing = utf16be ? Buffer.from(bytes).swap16().toString('utf16le')
        : bytes.toString(utf16le ? 'utf16le' : 'utf8');
      const strings = Object.entries(copy).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n');
      const block = `\n// Cindy permission translations\n${strings}\n// End Cindy permission translations\n`;
      // Xcode can compile .strings into binary or XML plists. Let macOS read
      // those formats, preserving all original keys before writing UTF-8 strings.
      if (existing.startsWith('bplist') || /^\s*(?:<\?xml|<plist)/.test(existing.replace(/^\ufeff/, ''))) {
        const original = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
        const preserved = Object.entries(original).filter(([key]) => !Object.hasOwn(copy, key))
          .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n');
        fs.writeFileSync(file, `${preserved}${block}`, 'utf8');
        continue;
      }
      if (existing.includes('\u0000')) {
        throw new Error(`Unsupported InfoPlist.strings encoding: ${file}`);
      }
      const preserved = existing.replace(/\n\/\/ Cindy permission translations\n[\s\S]*?\/\/ End Cindy permission translations\n/g, '');
      const text = `${preserved}${block}`;
      const output = Buffer.from(text, utf16le || utf16be ? 'utf16le' : 'utf8');
      fs.writeFileSync(file, utf16be ? output.swap16() : output);
    }
  }
}
