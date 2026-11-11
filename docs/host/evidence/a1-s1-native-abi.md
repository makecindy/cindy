# A1 · S1 原生模块 ABI 隔离（2026-11-06）

结论：仓库已有隔离机制，无需新增代码。`docs/host/electron-client-mode.md` 末行"两者无法在同一
checkout 同时运行"的说法已过时。

## 机制

- 根 `node_modules/better-sqlite3`（hoisted）保持 **Node ABI**，供 Host 使用。
- `scripts/ensure-deps.mjs` 把 Electron 版产物编译到
  `node_modules/.xdt-electron-native/electron-<版本>-<平台>-<架构>-better-sqlite3-<版本>/`。
- `apps/desktop/src/main/localDb/betterSqliteFactory.ts` 在非打包的 Electron 进程里自动选用该缓存，
  也可用环境变量 `XDT_BETTER_SQLITE3_NATIVE_BINDING` 显式指定。
- `electron-rebuild` 在 hoisted 工作区下会回写根包，`ensure-deps` 之后会立刻探测并恢复 Node ABI。

## 实测

```text
$ node scripts/ensure-deps.mjs
[ensure-deps] Electron native cache 缺少 …/electron-42.11.12-linux-x64-better-sqlite3-12.11.1/…
[ensure-deps] 编译 Electron 42.11.12 (x64) 专用 better-sqlite3 native binding
✔ Rebuild Complete
[ensure-deps] better-sqlite3 root Node ABI 不可用，按当前 Node 重建     # 被 electron-rebuild 回写
[ensure-deps] better-sqlite3 root Node ABI 已恢复
```

之后：

- `node -e "new (require('better-sqlite3'))(':memory:')"` 成功（根目录 Node ABI，Node 22.22.3 / modules 127）。
- Electron 缓存下存在 `better_sqlite3.node`（2163320 字节），与根目录的二进制 `cmp` 结果不同，确为两份不同 ABI 的文件。

## 注意

- `ensure-deps` 运行中，根目录绑定有一小段时间处于 Electron ABI。**此时不要启动或重启 Host**，
  否则 Host 会因 ABI 不匹配启动失败。
- 每次 `pnpm install` 或升级 Electron 后，缓存需要重新生成。
