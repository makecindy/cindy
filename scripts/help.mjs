import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function printHelp(log = console.log) {
  log('\n  Cindy 客户端仓常用指令（按场景分组，说明在上、指令在下，可直接复制）');

  log('\n  桌面端启动:');
  log('    # 推荐：先清理已有 Cindy dev 进程，再启动远程 API 模式');
  log('    # 国内版，读取仓内 config/endpoint.json');
  log('    pnpm restart:desktop:remote --region=cn');
  log('    # 海外版，读取仓内 config/endpoint.global.json');
  log('    pnpm restart:desktop:remote --region=global');
  log('    # 海外版，读取对应区域的线上 CDN 端点清单');
  log('    pnpm restart:desktop:remote --region=global --endpoints-cdn');
  log('    # Human 可直接启动；不会先清旧进程，Agent 不要使用');
  log('    pnpm dev:desktop:remote --region=cn');
  log('    pnpm dev:desktop:remote --region=global');
  log('    # 连接本地 http://localhost:3333（只起客户端，不起 server）');
  log('    pnpm restart:desktop:local --region=cn');

  log('\n  Agent 二进制安装 / 升级（Claude Code、Codex、ripgrep）:');
  log('    # 按 latest.json 当前 pin 安装到本机，不修改 pin');
  log('    # 安装当前平台的全部三种二进制');
  log('    pnpm install:agent-binaries');
  log('    # 只安装当前平台的指定二进制');
  log('    pnpm install:claude');
  log('    pnpm install:codex');
  log('    pnpm install:ripgrep');
  log('    # 升级到上游最新版：下载全平台二进制，并修改对应 latest.json pin');
  log('    pnpm update:claude');
  log('    pnpm update:codex');
  log('    pnpm update:ripgrep');
  log('    # 依次把三种二进制全部升级到上游最新版');
  log('    pnpm update:vendors');
  log('    # 固定到指定版本：下面是完整示例，会修改 latest.json pin');
  log('    pnpm update:claude 2.1.199');
  log('    pnpm update:codex 0.144.1');
  log('    pnpm update:ripgrep 15.1.0');

  log('\n  Mobile 本地开发:');
  log('    # 国服：生成 iOS 工程、打开 Xcode 并启动 Metro');
  log('    pnpm mobile:xcode');
  log('    # 海外版：生成 iOS 工程、打开 Xcode 并启动 Metro');
  log('    pnpm mobile:xcode --region=global');
  log('    # 国服模拟器：先 rebuild 安装，再 start 启动 Metro');
  log('    pnpm mobile:sim:rebuild');
  log('    pnpm mobile:sim:start');
  log('    # 海外模拟器：先 rebuild 安装，再 start 启动 Metro');
  log('    pnpm mobile:sim:rebuild -- --region=global');
  log('    pnpm mobile:sim:start -- --region=global');
  log('    # 查看当前 Metro 对应的 checkout / branch');
  log('    pnpm mobile:sim:whoami');

  log('\n  Mobile 构建(纯构建,无上传/发布;region 必填,无默认值):');
  log('    # 配置:按 apps/mobile/scripts/self-host-regions.json.example 复制填写');
  log('    # self-host-regions.json(gitignore);构建只需 authRegion / 应用身份 / 签名段');
  log('    # iOS(需 macOS + Xcode + 本机证书/描述文件)');
  log('    pnpm mobile:build:ios -- --region cn            # dry-run 校验 + 打印计划');
  log('    pnpm mobile:build:ios -- --region cn --execute  # 真正构建,产出 .ipa');
  log('    # Android(需 Android SDK + JDK 17 + keystore 口令 env)');
  log('    pnpm mobile:build:android -- --region cn');
  log('    pnpm mobile:build:android -- --region cn --execute');
  log('    # 常用可选参数:--out <dir> 拷产物 / --desktop-version x.y.z / --version-code <n>(仅 Android)');

  log('\n  开发检查:');
  log('    pnpm lint');
  log('    pnpm test:runner');
  log('    pnpm test:unit');
  log('    pnpm test:all');
  log('    pnpm test:db');
  log('    pnpm test:guard');
  log();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printHelp();
}
