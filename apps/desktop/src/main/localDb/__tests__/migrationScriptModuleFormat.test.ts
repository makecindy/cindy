/**
 * 回归 #690：companion 脚本用 `module.exports` 导出，靠 Node type stripping 以
 * CommonJS `require()` 加载。模块格式由「最近的 package.json `type` 字段」决定——
 * 当安装路径的某个祖先目录存在 `"type": "module"` 的 package.json（Windows 安装在
 * 用户目录下、或 macOS 从 Downloads 直接运行时都可能撞上用户自己的 package.json），
 * 脚本会被当作 ESM 加载，`module.exports` 直接抛
 * "module is not defined in ES module scope"，全部迁移失败（MIGRATE_FAILED）。
 *
 * 修复：`drizzle/scripts/package.json` 钉死 `{"type": "commonjs"}`，让最近的
 * package.json 永远是我们自己的。本测试把真实 scripts 目录整体拷进一个
 * `"type": "module"` 祖先目录下，再用子进程逐个 require，验证钉子生效。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const realScriptsDir = path.resolve(__dirname, '../../../../drizzle/scripts');

/**
 * 子进程 require 原始 `.ts` 依赖 Node type stripping：22.18+ 默认开启
 * （`process.features.typescript` 为 'strip'），22.6–22.17 需显式
 * `--experimental-strip-types`，更早的 22.x 完全不支持（跳过本用例——生产
 * 运行时是 Electron 41 / Node 24，钉子本身不受影响）。
 */
const typeStripArgs = process.features.typescript ? [] : ['--experimental-strip-types'];
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
const nodeCanStripTypes =
  Boolean(process.features.typescript) || nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration companion script module format', () => {
  it('drizzle/scripts 携带 type=commonjs 钉子', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(realScriptsDir, 'package.json'), 'utf8'),
    ) as { type?: string };
    expect(pkg.type).toBe('commonjs');
  });

  it.runIf(nodeCanStripTypes)(
    '祖先目录 type=module 时所有 companion 脚本仍可 require 并导出 run()',
    () => {
      const ancestor = mkdtempSync(path.join(tmpdir(), 'cindy-esm-ancestor-'));
      cleanupDirs.push(ancestor);
      writeFileSync(path.join(ancestor, 'package.json'), '{"type":"module"}\n', 'utf8');
      const scriptsDir = path.join(ancestor, 'drizzle', 'scripts');
      cpSync(realScriptsDir, scriptsDir, { recursive: true });

      const scriptFiles = readdirSync(scriptsDir).filter((name) => /^\d{4}_.*\.ts$/.test(name));
      expect(scriptFiles.length).toBeGreaterThan(0);

      const probe = `
        const results = {};
        for (const file of ${JSON.stringify(scriptFiles)}) {
          try {
            const mod = require(${JSON.stringify(scriptsDir)} + '/' + file);
            results[file] = typeof mod.run;
          } catch (err) {
            const msg = String(err && err.message ? err.message : err);
            results[file] = 'throw: ' + msg.split('\\n')[0];
          }
        }
        process.stdout.write(JSON.stringify(results));
      `;
      const stdout = execFileSync(process.execPath, [...typeStripArgs, '-e', probe], {
        encoding: 'utf8',
      });
      const results = JSON.parse(stdout) as Record<string, string>;
      for (const file of scriptFiles) {
        expect(results[file], file).toBe('function');
      }
    },
  );
});
