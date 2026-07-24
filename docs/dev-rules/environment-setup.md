# 开发环境与依赖准备

> **读取时机**：首次克隆、创建新 worktree、缺少依赖或安装命令失败时

## 环境要求

- Node.js 与 pnpm 版本以根 `package.json` 的 `engines` 和 `packageManager` 为准。
- Git 与 Git LFS。

先核对实际版本：

```bash
node --version
pnpm --version
git lfs version
```

## 安装

公开贡献者只初始化普通开发必需且公开可访问的 submodule，不要索取、复制或写入凭证：

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol
git lfs pull
pnpm install
```

`pnpm install` 的 postinstall 会按当前平台 **best-effort 自动下载 agent 二进制**
（claude／codex／ripgrep，不入 git；失败只告警不阻断），dev 启动前的 guard 会再确认。
正常情况下无需手动安装二进制。

新 worktree 不共享 `node_modules`。确认 checkout 已完成且根 `package.json` 存在后，
在该 worktree 内重新运行 `pnpm install`。

## Linux：Electron SUID sandbox 权限

较新的 Ubuntu（23.10+ 默认用 AppArmor 限制非特权 user namespace）上，Electron 会退回
SUID sandbox，dev 启动时报
`The SUID sandbox helper binary was found, but is not configured correctly`。修复：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

注意：

- `node_modules/electron/dist` 由 electron postinstall 解包，**每次重装依赖或 electron
  升版本后该权限都会被重置**，需要重跑上面两条命令（每个 worktree 各自独立）。
- 只做这两条针对性修复；不要放开系统级 user namespace 限制，更不要用 `--no-sandbox`
  绕过（违反 Electron 安全边界，参见
  [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)）。

## 不变量

- submodule 版本由父仓 gitlink 锁定；普通同步不得使用 `git submodule update --remote`。
- 旧 checkout 拉到 `.gitmodules` URL 迁移后，开发脚本会先执行
  `git submodule sync -- cindy-protocol`；手动更新 submodule 前也应先执行同一命令，
  避免继续使用 `.git/config` 缓存的旧仓库地址。
- 公开版本不包含内建插件种子；插件通过 SkillHub 或手动安装。不要把任何访问令牌写入
  仓库、Git 配置或脚本。
- agent 二进制（claude／codex／ripgrep）的版本由仓库维护者统一判断与升级；贡献者和
  Agent 不要修改 `tools/<kind>/latest.json` 的版本 pin，也不要主动升级二进制。
- 依赖和命令的事实源是当前 checkout 的 `package.json` 与脚本。文档和脚本冲突时，
  先核对代码并修正文档，不要继续执行已失效命令。
- 不要把其他 checkout 的 `node_modules`、用户数据、授权文件或数据库复制进当前工作区。

贡献方式与 PR 流程见仓库根 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
