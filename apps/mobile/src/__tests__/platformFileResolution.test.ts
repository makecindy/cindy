import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

/* 测试价值
 * guard（跨文件静态契约，engineering-conventions §3.2：模块解析只能静态核对）。Metro 解析 `./name` 时按项目
 * sourceExts 的顺序逐个扩展名试 `.<platform>.<ext>`、`.native.<ext>`、`.<ext>`：平台文件与通用文件扩展名不同时，
 * 排在前面的扩展名上的通用文件会先命中，平台文件从不进包。Vitest 的解析与 Metro 不同，组件测试发现不了。
 * 依据：#12684 iOS 第六轮补拍（dispatcher P-1）：usePluginPrompt.ios.tsx 被 usePluginPrompt.ts 遮蔽，iOS 一直用的是
 * 通用实现（系统提示框，按钮被裁），组件测试却一直测的是 iOS 文件。
 * 最小失败输入：同目录 `x.ts` 与 `x.ios.tsx`。失效后果：平台实现静默不生效。tier：guard（读目录与 Metro 配置）。
 */
const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const PLATFORMS = ['ios', 'android'] as const;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out); else out.push(relative(root, path));
  }
  return out;
}

it('never lets a generic file shadow a platform file under Metro resolution order', () => {
  // The project's own Metro configuration, as the bundler reads it.
  const sourceExts: string[] = require(join(root, 'metro.config.js')).resolver.sourceExts;
  expect(sourceExts.length).toBeGreaterThan(0);
  const all = [...files(join(root, 'src')), ...files(join(root, 'app'))].filter((file) => !/\.test\.[^.]+$/.test(file));
  const present = new Set(all);
  const pattern = new RegExp(`^(.*?)(?:\\.(ios|android|native))?\\.(${sourceExts.map((ext) => ext.replace(/\./g, '\\.')).join('|')})$`);
  const platformFiles = new Map<string, string[]>();
  for (const file of all) {
    const match = pattern.exec(file);
    if (match?.[2]) platformFiles.set(match[1]!, [...(platformFiles.get(match[1]!) ?? []), file]);
  }
  expect(platformFiles.size).toBeGreaterThan(0);
  const shadowed: string[] = [];
  for (const [base, own] of platformFiles) {
    for (const platform of PLATFORMS) {
      const mine = own.filter((file) => file.startsWith(`${base}.${platform}.`) || file.startsWith(`${base}.native.`));
      if (!mine.length) continue;
      let hit: string | undefined;
      for (const ext of sourceExts) {
        hit = [`${base}.${platform}.${ext}`, `${base}.native.${ext}`, `${base}.${ext}`].find((candidate) => present.has(candidate));
        if (hit) break;
      }
      if (!hit || !mine.includes(hit)) shadowed.push(`${platform}: ${hit ?? '(nothing)'} hides ${mine.join(', ')}`);
    }
  }
  expect(shadowed).toEqual([]);
});
