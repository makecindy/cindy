/**
 * 守卫:apps/mobile 依赖(含传递依赖)的所有 workspace 包,都必须在仓库根 `.easignore`
 * 的 packages 白名单里放行,否则 EAS 上传的归档不含该包源码,云端 `pnpm install` 解析不到
 * `workspace:*` → Prebuild/安装阶段失败(本地有 node_modules 故不复现)。
 *
 * 背景:2026-06 给手机版加 `@cindy/model-providers` 依赖,但漏了同步 `.easignore` 白名单,
 * 导致 TestFlight 构建在 Prebuild 阶段失败。本测试把"加 workspace 依赖须同步 .easignore"
 * 这条约定变成代码强制——再漏 CI 当场拦下,并直接给出该补的 .easignore 行。
 *
 * 纯文件读取(node env,不 import react-native)。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest 在 apps/mobile 下运行(`pnpm --filter mobile test`),故 cwd = apps/mobile。
const mobileDir = process.cwd();
const repoRoot = resolve(mobileDir, '..', '..');
const packagesDir = resolve(repoRoot, 'packages');

function readJson(path: string): { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 本地 workspace 包名 → packages/ 下的目录名(名称与目录可能不同,故按 package.json 建表)。 */
function buildNameToDir(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of readdirSync(packagesDir)) {
    const pkgPath = resolve(packagesDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const name = readJson(pkgPath).name;
    if (name) map.set(name, dir);
  }
  return map;
}

/** 某 package.json 里指向本地 workspace 包的依赖(deps + devDeps)。 */
function localDepNames(pkg: ReturnType<typeof readJson>, nameToDir: Map<string, string>): string[] {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return Object.keys(all).filter((name) => nameToDir.has(name));
}

describe('EAS .easignore covers apps/mobile workspace dependency closure', () => {
  it('includes the generated legal notices consumed by the Expo config plugin', () => {
    const easignore = readFileSync(resolve(repoRoot, '.easignore'), 'utf8');

    expect(easignore).toMatch(/^docs$/m);
    expect(easignore).toMatch(/^!docs\/$/m);
    expect(easignore).toMatch(/^!docs\/legal\/$/m);
    expect(easignore).toMatch(/^!docs\/legal\/notices\/$/m);
    for (const artifact of [
      'mobile-ios.txt',
      'mobile-ios-restricted.txt',
      'mobile-android.txt',
      'mobile-android-restricted.txt',
    ]) {
      expect(easignore).toMatch(
        new RegExp(`^!docs/legal/notices/${artifact.replace('.', '\\.')}\\s*$`, 'm'),
      );
    }
  });

  it('includes the root postinstall skip path used by mobile EAS builds', () => {
    const easignore = readFileSync(resolve(repoRoot, '.easignore'), 'utf8');
    const easJson = readJson(resolve(mobileDir, 'eas.json')) as {
      build?: Record<string, { env?: Record<string, string> }>;
    };

    expect(easignore).toMatch(/^scripts\/\*$/m);
    expect(easignore).not.toMatch(/^!scripts$/m);
    expect(easignore).toMatch(/^!scripts\/ensure-agent-binaries\.mjs$/m);
    expect(easignore).toMatch(/^!scripts\/agent-binary-cdn-fallback\.mjs$/m);
    expect(easignore).toMatch(/^!scripts\/fix-node-pty-perms\.mjs$/m);
    expect(easignore).toMatch(/^!scripts\/shared$/m);
    expect(easignore).toMatch(
      /^!scripts\/shared\/client-endpoint-build-env\.cjs$/m,
    );
    expect(easignore).toMatch(/^!tools\/shared\/fetch-with-timeout\.mjs$/m);
    // beta EAS lane 已在 79013fcc 退役,eas.json 不再有 beta-base profile。
    for (const profile of [
      'store-cn-base',
      'store-global-base',
      'adhoc',
    ]) {
      expect(easJson.build?.[profile]?.env?.XDT_SKIP_AGENT_BIN_INSTALL).toBe(
        '1',
      );
    }
  });

  it('每个被 apps/mobile 传递依赖的 workspace 包都在 .easignore 放行', () => {
    const nameToDir = buildNameToDir();
    const mobilePkg = readJson(resolve(mobileDir, 'package.json'));

    // 从 apps/mobile 出发,BFS 求 workspace 依赖的传递闭包(目录名集合)。
    const closure = new Set<string>();
    const queue = localDepNames(mobilePkg, nameToDir).map((name) => nameToDir.get(name)!);
    while (queue.length > 0) {
      const dir = queue.shift()!;
      if (closure.has(dir)) continue;
      closure.add(dir);
      for (const depName of localDepNames(readJson(resolve(packagesDir, dir, 'package.json')), nameToDir)) {
        const depDir = nameToDir.get(depName)!;
        if (!closure.has(depDir)) queue.push(depDir);
      }
    }

    const easignore = readFileSync(resolve(repoRoot, '.easignore'), 'utf8');
    const isAllowlisted = (dir: string) =>
      new RegExp(String.raw`^!packages/${dir}(/\*\*)?\s*$`, 'm').test(easignore);

    const missing = [...closure].sort().filter((dir) => !isAllowlisted(dir));
    if (missing.length > 0) {
      const toAdd = missing.flatMap((d) => [`!packages/${d}`, `!packages/${d}/**`]).join('\n');
      throw new Error(
        `以下 workspace 包被 apps/mobile 依赖但未在 .easignore 放行,EAS 构建会失败:\n` +
        `  ${missing.join(', ')}\n请在 .easignore 的 packages 白名单区补:\n${toAdd}`,
      );
    }
    expect(missing).toEqual([]);
  });
});
