# 在自有电脑验证 Host

这份流程供维护者在自有机器上做发布前验证。下文的机器列表、别名和远端任务命令来自维护者自己的测试工具。外部贡献者只需按对应平台的说明准备 Node 和依赖，再按「Host 门禁与回执」运行命令、记录结果。

Ubuntu x64、Windows x64、macOS arm64 分别验证同一份待发布源码。每台机器用独立的任务目录安装 Node 和依赖。Host 回归入口和验收脚本以待测提交的 [Host CI 作业](../../.github/workflows/ci.yml) 和 [Host package.json](../../apps/host/package.json) 为准。

## 准备同一份源码

1. 在集成分支工作区记录 `git rev-parse HEAD`、`git status --short`、`git lfs ls-files`。核对需要的 LFS 文件已经展开。将改动中的文件与新文件一并计入快照，记录排除项。
2. 在自有电脑列表里选择 Ubuntu、Windows 和一台空闲的 Mac。用各自 alias 生成 `preflight-command`，通过 Cindy SSH 执行并用 `record-preflight` 保存原始回执。检查可用磁盘、CPU、内存、活动 runner，实测 Git、Python、编译器和归档工具。Windows 用 `py -3 --version` 和 Visual Studio Installer 的 `vswhere` 核对 C++ 工具；macOS 检查 `xcode-select -p`。本流程无需系统级安装。
3. 用 `sync` 建立独立任务，核对 manifest。仓库文件多时，可先在仓库外把**已审核的传输清单**做成 tar.gz，分成小于 50 MiB 的分片再同步。归档前逐文件检查敏感文件排除项、符号链接、LFS 指针与总容量；随包附上原提交、逐文件 SHA256、排除清单及检查脚本。远端按片名顺序二进制拼接，解压到任务的 `src`，逐文件核对。三台机器应具有相同的源码摘要。源码有变化就新建任务。
4. 各步骤通过 `prepare-run TASK SCRIPT` 后执行回执里的 SSH 命令。长步骤按实际耗时拆分，超过原生时限的单项可用 `run-long`。下面的命令都从远端任务的 `src` 执行，环境变量要在每次运行时重新加载。

## 先清点二进制，再准备依赖

每台机器、每份快照都要在下载前向负责人报清单。每行记录工具、平台、版本、是否已经在本次任务内可用、用途、获取来源、归档字节数和校验依据。可以用 HTTP HEAD 读取归档大小；registry 返回分块响应时用带 `Range: bytes=0-0` 的 HEAD 查看 `Content-Range` 分母。已有归档记录实际大小与哈希。需要获取的项等本轮确认后再取；发现新下载就停止并补报。

| 项目 | 清点和准备方法 |
| --- | --- |
| Node、Corepack、pnpm | 核对 `.nvmrc` 和 `packageManager`，优先复用已按官方 SHASUMS256 校验的同平台归档。Windows 另列同版本 headers 和 node.lib。 |
| npm 依赖中的原生程序 | 从本次 lockfile 导出 registry 包名、版本、完整性摘要、tarball 来源和字节数。包含 esbuild、sharp、node-pty、各平台 Claude Agent SDK 等。注明已缓存的包与新环境可能获取的上限，better-sqlite3 使用任务内 Node 的头文件编译。 |
| Electron | 区分 npm 的 JS 包和对应平台的 Electron 运行时。源码空 profile 验收只需 JS 包。需要真实运行时的用例要单列平台、版本、来源、大小和校验值；获准后在任务内预置并核对 `dist` 中的应用和 `path.txt`。 |
| Chromium | 记录 Playwright 的浏览器 revision。需要真实浏览器时，确认归档后设置任务专用的 `PLAYWRIGHT_BROWSERS_PATH`；只运行 Host 源码健康探针时不取浏览器。 |
| Claude Code、Codex、Pi、ripgrep | 区分打包用的独立可执行文件、npm 包附带的程序和测试夹具。逐项记录已提供、需获取或本轮不用。常规无账号 Host 验证设置 `XDT_SKIP_AGENT_BIN_INSTALL=1`，涉及真实引擎、独立 rg 或真实账号的结果单列。 |

Electron 42.11.12 的历史验收曾触发其 npm 包自带的 `install.js`。自有 macOS 任务目录出现完整的 Electron 分发包，自有 Windows 任务目录出现未完成的下载文件。两处均已清理。修复前，执行真实子 Host 的 startup-account、IPC 或 lifecycle 等路径可能在启动或刷新空会话时解析 Electron 包入口。入口发现 `path.txt` 缺失，或指向的 dist 程序缺失，就同步启动下载器。源码 Host 从 `a6cb62e1af` 起直接检查包旁的 `path.txt` 与实际文件，原生凭据操作延迟到真正加解密时解析可执行文件。

锁定版本的 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 会让仓库根 postinstall 跳过补装；Electron 42.11.12 的入口及其 `install.js` 本身都不读取它。`ELECTRON_OVERRIDE_DIST_PATH` 让 npm 包入口直接返回该目录下的路径，可供已有分发包的验收使用。验证“没有 Electron 也能启动”时清除此变量，并在测试前后检查 `path.txt`、dist 和子进程记录，避免路径覆盖掩盖回归。`electron_config_cache` 只控制下载缓存位置；`ELECTRON_MIRROR` / `npm_config_electron_mirror` 控制下载来源；`ELECTRON_GET_USE_PROXY` 让该版下载依赖启用环境代理。这些变量均不保证禁止下载。使用替换过的镜像时还要检查优先级更高的 npm 配置和包配置。

曾验收的 Chrome for Testing 153.0.8010.12 归档没有可供比对的官方 checksum。报告记录了归档、解压程序和候选包内程序的 SHA256，用于这一次临时验收和核对打包前后文件一致。

## Ubuntu 和 macOS

下面的 Bash 命令使用系统已有的 curl、tar、编译器和 Python。任务目录内的 Node 发行包自带头文件，可供 better-sqlite3 本机编译。

```bash
set -euo pipefail
task=$(cd .. && pwd -P)
mkdir -p "$task"/{tools/bin,home,tmp}
version=$(tr -d '[:space:]' < .nvmrc)
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64; ext=tar.xz ;;
  Darwin-arm64) platform=darwin-arm64; ext=tar.gz ;;
  *) exit 2 ;;
esac
dist="node-v$version-$platform"
archive="$dist.$ext"
base="https://nodejs.org/dist/v$version"
(
  cd "$task/tools"
  curl -fsSLO "$base/SHASUMS256.txt"
  curl -fsSLO "$base/$archive"
  hash=$(awk -v name="$archive" '$2 == name {print $1}' SHASUMS256.txt)
  test -n "$hash"
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$hash" "$archive" | sha256sum -c -
  else
    printf '%s  %s\n' "$hash" "$archive" | shasum -a 256 -c -
  fi
  tar -xf "$archive"
)
export PATH="$task/tools/bin:$task/tools/$dist/bin:$PATH"
export HOME="$task/home" USERPROFILE="$task/home"
export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
export COREPACK_HOME="$task/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export npm_config_cache="$HOME/.npm" npm_config_nodedir="$task/tools/$dist"
export npm_config_build_from_source=better-sqlite3 SHARP_IGNORE_GLOBAL_LIBVIPS=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 XDT_SKIP_AGENT_BIN_INSTALL=1
git config --global user.name 'Fixture Tester'
git config --global user.email fixture@example.invalid
corepack enable --install-directory "$task/tools/bin" pnpm
node --version
pnpm --version
pnpm install --frozen-lockfile --os="$(node -p process.platform)" --cpu="$(node -p process.arch)" --libc=current --store-dir "$task/pnpm-store"
(cd apps/host && node -e "const db=new (require('better-sqlite3'))(':memory:'); console.log(db.prepare('select sqlite_version() v').get()); db.close()")
```

`pnpm --version` 应与根 package.json 的 `packageManager` 一致。仓库为了制作跨平台产物配置了多个架构。上述安装参数将可选依赖限定到本机平台；保留下载明细，并核对每个实际获取的包来自获准的 registry、与冻结锁文件的 integrity 相符。测试继续使用临时 HOME 和测试 Git 身份。

## Windows

在 PowerShell 中从任务的 `src` 开始，使用官方 Windows zip。每个外部命令都要采集退出码，下面用一个函数传播安装失败。

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-Checked($program, [string[]]$argv) {
  & $program @argv
  if ($LASTEXITCODE -ne 0) { throw "$program exited $LASTEXITCODE" }
}
$task = Split-Path -Parent (Get-Location).Path
$v = (Get-Content -Raw .nvmrc).Trim()
$dist = "node-v$v-win-x64"
$tools = Join-Path $task 'tools'
$node = Join-Path $tools $dist
$base = "https://nodejs.org/dist/v$v"
New-Item -ItemType Directory -Force "$tools/bin","$task/home","$task/tmp" | Out-Null
foreach ($name in @("$dist.zip",'SHASUMS256.txt')) {
  Invoke-Checked curl.exe @('-fsSL','-o',"$tools/$name","$base/$name")
}
$expected = Get-Content "$tools/SHASUMS256.txt" | ForEach-Object {
  $parts = $_ -split '\s+'
  if ($parts[1] -eq "$dist.zip") { $parts[0] }
}
if (!$expected -or (Get-FileHash "$tools/$dist.zip" -Algorithm SHA256).Hash -ne $expected) {
  throw 'Node zip SHA256 mismatch'
}
Invoke-Checked tar.exe @('-xf',"$tools/$dist.zip",'-C',$tools)
$python = (& py.exe -3 -c 'import sys; print(sys.executable)')
if ($LASTEXITCODE -ne 0 -or !$python) { throw 'Python 3 is required' }
$env:PATH = "$tools/bin;$node;$env:PATH"
$env:USERPROFILE = $env:HOME = "$task/home"
$env:APPDATA = "$task/home/AppData/Roaming"
$env:LOCALAPPDATA = "$task/home/AppData/Local"
New-Item -ItemType Directory -Force $env:APPDATA,$env:LOCALAPPDATA | Out-Null
$env:COREPACK_HOME = "$task/corepack"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:npm_config_cache = "$task/home/npm-cache"
$env:npm_config_devdir = "$task/node-gyp"
$env:npm_config_python = $python
$env:npm_config_build_from_source = 'better-sqlite3'
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = $env:XDT_SKIP_AGENT_BIN_INSTALL = '1'
$env:SHARP_IGNORE_GLOBAL_LIBVIPS = '1'
Invoke-Checked git @('config','--global','user.name','Fixture Tester')
Invoke-Checked git @('config','--global','user.email','fixture@example.invalid')
Invoke-Checked corepack.cmd @('enable','--install-directory',"$tools/bin",'pnpm')
Invoke-Checked node @('--version')
Invoke-Checked pnpm.cmd @('--version')
```

Windows 的运行时 zip 缺少编译 better-sqlite3 所需的开发文件。本次自有测试机只按官方 `SHASUMS256.txt` 校验了头文件和 `win-x64/node.lib` 的 SHA256，未验证签名。这两个文件只用于自有测试机的本次构建。先报告附加下载，再从同一官方发行目录取文件、逐个核验摘要，把头文件和链接库放到 node-gyp 指定的位置。在上述 PowerShell 环境运行：

```powershell
$headers = "node-v$v-headers.tar.gz"
foreach ($asset in @($headers, 'win-x64/node.lib')) {
  $output = Join-Path $tools (Split-Path -Leaf $asset)
  $sha = @(Get-Content "$tools/SHASUMS256.txt" | ForEach-Object {
    $parts = $_ -split '\s+'
    if ($parts[1] -eq $asset) { $parts[0] }
  })
  if ($sha.Count -ne 1) { throw "Missing official checksum for $asset" }
  Invoke-Checked curl.exe @('-fsSL','-o',$output,"$base/$asset")
  if ((Get-FileHash $output -Algorithm SHA256).Hash -ne $sha[0]) {
    throw "SHA256 mismatch for $asset"
  }
}
Invoke-Checked tar.exe @('-xf',"$tools/$headers",'-C',$tools)
$env:npm_config_nodedir = "$tools/node-v$v"
New-Item -ItemType Directory -Force "$env:npm_config_nodedir/Release" | Out-Null
Copy-Item "$tools/node.lib" "$env:npm_config_nodedir/Release/node.lib"
Invoke-Checked pnpm.cmd @('install','--frozen-lockfile','--os=win32','--cpu=x64','--libc=current','--store-dir',"$task/pnpm-store")
Push-Location apps/host
try {
  Invoke-Checked node @('-e',"const db=new (require('better-sqlite3'))(':memory:'); console.log(db.prepare('select sqlite_version() v').get()); db.close()")
} finally { Pop-Location }
```

## Host 门禁与回执

每条命令的回执写明机器类型、命令、Node 版本、结果、开跑负载、日志、TMPDIR 是否显式设为真实路径及实际语言环境。新写或修改的测试至少有一轮使用默认临时目录与语言。Unix 在测试子 shell 中执行 `unset TMPDIR`，保留登录环境原有的 LANG 和 LC_*。Windows 在测试进程中清除 TMPDIR，保留原有的 TEMP、TMP 和系统区域设置。两种模式都继续隔离 HOME、应用数据与缓存。若另测显式临时目录，将 TMPDIR 指向已创建目录的 realpath，分开记录两轮结果。

在每条被测命令前，从同一进程环境运行以下命令，保存临时目录的原始路径、真实路径、语言变量和 Node 实际采用的区域。Windows 另记录 `Get-Culture` 和 `Get-UICulture`。环境变量未设置时照实记录。

```sh
node -e "const os=require('node:os'),fs=require('node:fs'),p=os.tmpdir(),e=process.env; console.log({tmpdir:e.TMPDIR,osTmp:p,realTmp:fs.realpathSync(p),lang:e.LANG,lcAll:e.LC_ALL,lcCtype:e.LC_CTYPE,lcMessages:e.LC_MESSAGES,locale:Intl.DateTimeFormat().resolvedOptions().locale})"
```

依赖准备结束后，在测试进程及其子进程中默认关闭对外访问，保留回环 HTTP 给 Host、桌面代理和测试服务使用。沿用 startup-account 测试里的做法，将 HTTP/HTTPS 代理指向回环上确认没有服务监听的端口，同时设置大小写两套变量。用本次测试进程的网络隔离限制连接目的地，并验证回环可用、对外连接被拒；记录沙箱是否限制了 PID 查询。无法验证隔离生效时先报告，再决定如何执行。代理只约束识别这些变量的客户端，不能当作系统防火墙；发现清单外的下载尝试就立即停下，保留请求、子进程与缓存记录，报告给负责人。保持任务专用 HOME、数据目录和工具缓存，避免命中个人安装或账号。

```bash
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost,::1
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"
export NODE_USE_ENV_PROXY=1 ELECTRON_GET_USE_PROXY=1
export ELECTRON_MIRROR="$HTTP_PROXY/" npm_config_electron_mirror="$HTTP_PROXY/"
```

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:9'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:NODE_USE_ENV_PROXY = '1'
$env:ELECTRON_GET_USE_PROXY = '1'
$env:ELECTRON_MIRROR = "$($env:HTTP_PROXY)/"
$env:npm_config_electron_mirror = $env:ELECTRON_MIRROR
```

Windows 进程环境变量名不区分大小写。平台截图、浏览器或真实引擎等有外部依赖的用例，应先在准备阶段取得获准的产物，进入测试阶段后继续使用断网设置。

按表逐项运行并单独保存退出码。三台机器均跑类型检查。

| 工作目录 | 命令 | 范围 |
| --- | --- | --- |
| 根目录 | `pnpm --filter @cindy/host test` | 全部 Host 单元测试，含 startup-account.test.mjs |
| apps/host | `node scripts/check-e2e-imports.mjs` | 加载验收脚本的依赖 |
| apps/host | `node --import tsx --import ./src/loaders/register-raw.mjs scripts/provider-config.e2e.mjs` | 供应商配置验收 |
| 根目录 | `pnpm --filter @cindy/host test:ipc-route` | IPC 路由验收 |
| 根目录 | `pnpm --filter @cindy/host test:lifecycle` | Ubuntu 与 macOS；Windows 按 CI 记录跳过 |
| 根目录 | `pnpm --filter @cindy/host typecheck` | Host TypeScript |

Windows 可调用 `pnpm.cmd`。真实账号、浏览器及真实模型服务不属于本组门禁。默认安装会尝试准备平台对应的 bundled ripgrep；本流程设置的 `XDT_SKIP_AGENT_BIN_INSTALL=1` 会跳过这一步。`outbound-path-fact.test.mjs` 创建真实的 Agent 依赖图，需要这个可执行文件。如果用例因此报 `Bundled ripgrep not found`，保留命令的实际退出码，在报告中把该项列为缺少测试依赖、未验证，不计为产品失败。准备好同版本的平台产物后再验证该项。

用 `fetch TASK` 取回脚本、stdout/stderr 和 result.json，逐项记录用例数、断言、跳过项和机器实测版本。SSH 中断后先取回结果并核对任务进程。确认完成并保存日志后用 `clean TASK` 清自己的 UUID 目录。

## 发布前的 macOS 复核

先用该任务的 Node，在实际运行测试的临时目录下测一次文件监听：

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-watch-'));
let start, elapsed;
const watcher = fs.watch(dir, (_event, name) => {
  if (name === 'probe' && start !== undefined && elapsed === undefined)
    elapsed = performance.now() - start;
});
try {
  await delay(100);
  start = performance.now();
  fs.writeFileSync(path.join(dir, 'probe'), 'x');
  await delay(1000);
  console.log('fs.watch latency (ms)', elapsed);
  if (!(elapsed <= 500)) process.exitCode = 1;
} finally {
  watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
JS
```

一台自有 macOS Apple Silicon 机器在本次探针中用了 12 ms 收到目标文件事件。发布前应在当轮测试目录再测一次；探针通过后，可在同一台机器复核此前因 FSEvents 异常而标为「未验证」的测试。从 `apps/desktop` 逐条运行并保留各自的通过、失败和跳过数：

```bash
pnpm exec vitest run src/main/file-browser/__tests__/deviceOp.test.ts -t 'watch: subscribe starts local watch'
pnpm exec vitest run src/main/local-themes/__tests__/omarchy.test.ts
pnpm exec vitest run src/main/maker-host/__tests__/pi-package-store-security.test.ts
```

Claude 和 Codex 的 hosted e2e 会启动真实引擎并连接测试夹具。在仓库根确认这版 macOS arm64 对应的 `apps/claude-code-bin`、`apps/codex-package-bin` 和 `apps/ripgrep-bin` 产物已经准备好；缺少时测试会跳过。按前述步骤隔离 HOME，使用测试自建的网关。先在基准提交和发布候选上各独立跑三次 Codex resume，再在候选上分别跑两份完整文件。下面的命令都从 `apps/desktop` 运行，日志写到之前定义的 `$task`：

```bash
codex_test=src/main/remote-agent/__tests__/codexHosted.e2e.test.ts
for attempt in 1 2 3; do
  rc=0
  pnpm exec vitest run "$codex_test" -t 'releases an idle task under slot pressure and resumes the same Codex thread' > "$task/codex-resume-$attempt.log" 2>&1 || rc=$?
  echo "Codex resume $attempt exit=$rc"
done
pnpm exec vitest run "$codex_test"
pnpm exec vitest run src/main/remote-agent/__tests__/claudeHosted.e2e.test.ts
```

分别保存两份快照的日志。核实真实引擎用例实际执行；若测试超时，按本轮启动的 PID 核对残留进程。之后在正常负载下运行读者测试、related 和整套门禁。读者测试用文本搜索找读取改动源文件的测试（包括读源码的断言和 mock），related 以所有改过且仍存在的桌面源文件为输入。两轮明细均须留存。

在**有 Git 历史的发送端**、待测的干净 checkout 根目录，基准选目标主干的 merge-base。以下命令生成路径清单，随已核对的快照传输到远端的任务目录（与 `src` 同级）。存在未提交改动时，还应纳入新建的未跟踪源文件。

```bash
lists=$(mktemp -d)
base=$(git merge-base HEAD origin/main)
git diff --no-renames --name-only "$base" -- apps/desktop/src > "$lists/desktop-changes.txt"
git ls-files --others --exclude-standard -- apps/desktop/src >> "$lists/desktop-changes.txt"
```

其中 `lists` 是发送端存放清单的临时目录。从远端 `src/apps/desktop` 运行以下 Bash 命令；`rg` 需要在预检时确认可用，也可用已准备的本平台 ripgrep。路径筛选保留删除和改名的旧模块名供文本检索。若有跨包改动，对相应 workspace 同样收集和执行，核对放行表上点名的测试是否在最终集合中。

```bash
set -eo pipefail
task=$(cd ../../.. && pwd -P)
sources=()
reader_status=0
related_status=0
: > "$task/reader-patterns.txt"
while IFS= read -r file; do
  rel=${file#apps/desktop/}
  case "$rel" in *.test.*|*.spec.*) continue ;; *.ts|*.tsx|*.js|*.mjs|*.cjs) ;; *) continue ;; esac
  name=${rel##*/}
  printf '%s\n' "${name%.*}" >> "$task/reader-patterns.txt"
  if [[ -f "$rel" ]]; then sources+=("$rel"); fi
done < "$task/desktop-changes.txt"
if [[ -s "$task/reader-patterns.txt" ]]; then
  rc=0
  rg -l -F -f "$task/reader-patterns.txt" -g '*.test.*' -g '*.spec.*' src > "$task/readers.txt" || rc=$?
  (( rc <= 1 )) || exit "$rc"
  readers=()
  while IFS= read -r file; do readers+=("$file"); done < "$task/readers.txt"
  if (( ${#readers[@]} )); then pnpm exec vitest run "${readers[@]}" || reader_status=$?; fi
fi
if (( ${#sources[@]} )); then pnpm exec vitest related --run "${sources[@]}" || related_status=$?; fi
printf 'readers=%s related=%s\n' "$reader_status" "$related_status"
(( reader_status == 0 && related_status == 0 ))
```

记录每轮输入文件、实际发现的测试、失败和 skip 数。上面两步应分别采集退出码，一轮失败后仍需独立跑另一轮。仓库根的 `pnpm test:unit:related` 还会读取 Git 基准、工作树和新文件；在无 Git 历史的源码包上会退回全量。需要验证这个入口时，使用能解析同一 merge-base 的测试 checkout 并核对日志中的 `RELATED` 模式。最终整套的执行范围与基线见[个人版迁移放行表](personal-migration-release-table.md)。
