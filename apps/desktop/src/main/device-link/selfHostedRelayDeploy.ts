/**
 * 一键把自建中转部署到用户自己的 Linux 服务器(docs/self-hosted-relay-plan.md §15 方式 C)。
 *
 * 走「设置 → 远程」里已配置的 SSH 主机,需要 root 或免密 sudo(没有就停下来提示,不索要密码)。
 * 服务器上:
 *   /opt/cindy-relay/node        Node 运行环境(版本与 SHA-256 写死,官方源失败退回国内镜像)
 *   /opt/cindy-relay/relay.mjs   与 Cindy 内运行的同一个中转内核(单文件)
 *   /var/lib/cindy-relay         中转数据(设备档案、证书),属 cindy-relay 系统用户,0700
 *   cindy-relay.service          systemd 服务,只放行绑定 80/443 的权限
 * 自动复用正在使用 80/443 的 Nginx；已有可信证书时沿用，否则由中转申请并续期后同步给 Nginx。
 *
 * 主人身份(中转 ID、主人凭证、主人密钥)只在这台电脑生成与保存;交给服务器的只有凭证哈希、
 * 主人公钥与主人证书。命令里不出现任何秘密,也不把服务器输出写进日志。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { RELAY_VERSION } from '@cindy/device-link-relay';
import { createLogger } from '../logger.js';
import { ensureRemoteHostReady, getRemoteSshPool } from '../remote-ssh/index.js';
import type { RelayDeployErrorCode, RelayDeployProgressMessage, RelayDeployStep } from '../../shared/selfHostedRelay.js';

const log = createLogger('self-hosted-relay:deploy');

const INSTALL_DIR = '/opt/cindy-relay';
const DATA_DIR = '/var/lib/cindy-relay';
const NODE_VERSION = '24.22.1';
const NODE_SHA256: Record<'x64' | 'arm64', string> = {
  x64: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  arm64: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
};
const CERTIFICATE_WAIT_MS = 4 * 60 * 1000;
const CERTIFICATE_POLL_MS = 3_000;

export class RelayDeployError extends Error {
  constructor(
    readonly code: RelayDeployErrorCode,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'RelayDeployError';
  }
}

/** 首次部署时在服务器上初始化中转用的参数(都不是秘密)。 */
export interface RelayInitArgs {
  name: string;
  relayId: string;
  ownerUserId: string;
  ownerDeviceId: string;
  ownerDeviceName: string;
  ownerCredentialHash: string;
  ownerPublicKey: string;
  ownerCert: unknown;
}

export interface DeployParams {
  sshHostId: string;
  address: string;
  baseUrl: string;
  /** 服务器上已有不属于这台电脑的中转时,是否清掉重来。 */
  replaceExisting: boolean;
  /** 服务器上没有中转数据时用它初始化;已有本机主人的数据时保留原数据(升级)。 */
  init: RelayInitArgs;
  /** 国内网络:先试镜像再试官方源。 */
  preferMirror: boolean;
  onStep(step: RelayDeployStep): void;
  onProgress?(message: RelayDeployProgressMessage): void;
  /** 每次继续 SSH 操作前核对发起账号,避免连接等待期间换账号后取到另一份主机配置。 */
  assertCurrent?(): void;
  /** 检查通过、第一次改动服务器之前调用:调用方此时才保存部署记录与主人身份。 */
  onServerChange?(): void;
}

/** 只读检查的结论;检查不通过时抛出 RelayDeployError。 */
export interface RelayServerCheck {
  system: string;
  plan: 'direct' | 'nginx';
  existing: 'none' | 'mine' | 'other';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 中转程序单文件:开发时取包的构建产物,安装包里取 extraResource。 */
export function resolveRelayBundlePath(): string | null {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'device-link-relay', 'dist', 'relay.mjs'),
    path.join(process.resourcesPath ?? '', 'device-link-relay', 'relay.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'device-link-relay', 'dist', 'relay.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** 这个版本 Cindy 自带的中转版本;没带中转程序时为 null。 */
export function bundledRelayVersion(): string | null {
  return resolveRelayBundlePath() ? RELAY_VERSION : null;
}

function parseLines(stdout: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const [key, ...rest] = line.trim().split(' ');
    if (!key || !/^[A-Z_]+$/.test(key)) continue;
    result.set(key, [...(result.get(key) ?? []), rest.join(' ')]);
  }
  return result;
}

function first(lines: Map<string, string[]>, key: string): string | undefined {
  return lines.get(key)?.[0];
}

type Privilege = 'root' | 'sudo';

class Remote {
  constructor(
    private readonly host: RemoteHost,
    private readonly privilege: Privilege | null,
    private readonly assertCurrent: () => void,
  ) {}

  /** 以 root 运行一段脚本;参数逐个转义,脚本经 `bash -c` 传入,stdin 留给上传。 */
  async root(script: string, args: string[], options: { timeoutMs?: number; label: string; input?: Buffer; onProgress?: (message: RelayDeployProgressMessage) => void }) {
    this.assertCurrent();
    if (!this.privilege) throw new Error('privilege not determined');
    const command = `bash -c ${shellQuote(script)} cindy-relay ${args.map(shellQuote).join(' ')}`;
    const privilegedCommand = this.privilege === 'root' ? command : `sudo -n ${command}`;
    if (options.onProgress) return this.runtimeWithProgress(privilegedCommand, options.timeoutMs ?? 120_000, options.onProgress);
    return this.host.exec(privilegedCommand, {
      timeoutMs: options.timeoutMs ?? 120_000,
      label: options.label,
      input: options.input,
    });
  }

  /** 下载时边读边回报受控标记；原始输出只保留有界尾部用于现有错误判定。 */
  private async runtimeWithProgress(command: string, timeoutMs: number, onProgress: (message: RelayDeployProgressMessage) => void) {
    const stream = await this.host.execStream(command, { timeoutMs: Math.min(timeoutMs, 60_000) });
    try { this.assertCurrent(); } catch (error) { stream.kill(); throw error; }
    return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let line = '';
      let settled = false;
      const off: Array<() => void> = [];
      const cleanup = () => { clearTimeout(timer); off.forEach(unsubscribe => unsubscribe()); };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        stream.kill();
        reject(new RelayDeployError('DOWNLOAD_FAILED', error.message.slice(0, 300)));
      };
      const timer = setTimeout(() => fail(new Error('runtime download timed out')), timeoutMs);
      off.push(stream.onStdout(chunk => {
        stdout = (stdout + chunk).slice(-65_536);
        // 逐字符收行，防止远端无换行输出让解析缓冲无限增长。仅识别本脚本生成的事件。
        for (const char of chunk) {
          if (char === '\n') {
            const match = /^PROGRESS (runtime-cached|runtime-download|runtime-fallback|runtime-checksum|runtime-extract)\r?$/.exec(line);
            line = '';
            if (match) {
              try { onProgress(match[1] as RelayDeployProgressMessage); }
              catch (error) { fail(error instanceof Error ? error : new Error('deployment progress failed')); return; }
            }
          } else if (line.length < 256) line += char;
        }
      }));
      off.push(stream.onStderr(chunk => { stderr = (stderr + chunk).slice(-65_536); }));
      off.push(stream.onError(fail));
      off.push(stream.onClose(({ code }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stdout, stderr, exitCode: code });
      }));
      stream.end();
    });
  }

  async plain(script: string, label: string) {
    this.assertCurrent();
    return this.host.exec(`bash -c ${shellQuote(script)}`, { timeoutMs: 60_000, label });
  }

  withPrivilege(privilege: Privilege): Remote {
    return new Remote(this.host, privilege, this.assertCurrent);
  }
}

async function connect(sshHostId: string, assertCurrent: () => void): Promise<Remote> {
  assertCurrent();
  try {
    await ensureRemoteHostReady(sshHostId);
  } catch (error) {
    throw new RelayDeployError('SSH_FAILED', error instanceof Error ? error.message.slice(0, 300) : undefined);
  }
  assertCurrent();
  const host = getRemoteSshPool().get(sshHostId);
  if (!host) throw new RelayDeployError('SSH_FAILED');
  return new Remote(host, null, assertCurrent);
}

const PROBE_SCRIPT = `
echo "OS $(uname -s)"
echo "ARCH $(uname -m)"
if [ "$(id -u)" = 0 ]; then echo "ROOT root"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then echo "ROOT sudo"
else echo "ROOT none"; fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo "SYSTEMD yes"; else echo "SYSTEMD no"; fi
if [ -f /proc/net/if_inet6 ]; then echo "IPV6 yes"; else echo "IPV6 no"; fi
if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo "FETCH yes"; else echo "FETCH no"; fi
echo "DISTRO $( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
`;

const INSPECT_SCRIPT = `
NODE=${INSTALL_DIR}/node/bin/node
STATE=${DATA_DIR}/relay-state.json
if [ -f /etc/cindy-relay/nginx/state.json ]; then echo "NGINX_MANAGED yes"; fi
if [ -x "$NODE" ]; then echo "NODE $("$NODE" --version 2>/dev/null)"; fi
if [ -f "$STATE" ]; then
  if [ -x "$NODE" ]; then
    "$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("STATE "+s.schema+" "+s.relayId+" "+s.ownerPublicKey)}catch(e){console.log("STATE invalid")}' "$STATE"
  else echo "STATE unknown"; fi
fi
OWN=$(systemctl show -p MainPID --value cindy-relay 2>/dev/null || echo 0)
if command -v ss >/dev/null 2>&1; then
  ss -Hltnp 2>/dev/null | awk '{print $4" "$6}' | while read -r addr proc; do
    port="\${addr##*:}"
    if [ "$port" = 80 ] || [ "$port" = 443 ]; then
      case "$proc" in
        *"pid=$OWN,"*) ;;
        *docker-proxy*) echo "BUSY $port docker:$(docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null | head -n 3 | tr '\\n' ',')";;
        *) echo "BUSY $port $(echo "$proc" | sed -n 's/.*(("\\([^"]*\\)".*/\\1/p')";;
      esac
    fi
  done
fi
`;

const RUNTIME_SCRIPT = `
set -e
VERSION="$1"; SHA="$2"; URL_A="$3"; URL_B="$4"
NODE_DIR=${INSTALL_DIR}/node
if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" = "v$VERSION" ]; then echo "PROGRESS runtime-cached"; echo "NODE_READY cached"; exit 0; fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ok=""; attempted=""
for url in "$URL_A" "$URL_B"; do
  if [ -n "$attempted" ]; then echo "PROGRESS runtime-fallback"; fi
  attempted=1
  echo "PROGRESS runtime-download"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$TMP/node.tgz" "$url" || continue
  else
    wget -q -t 3 -T 30 -O "$TMP/node.tgz" "$url" || continue
  fi
  echo "PROGRESS runtime-checksum"
  if [ "$(sha256sum "$TMP/node.tgz" | cut -d' ' -f1)" = "$SHA" ]; then ok=1; break; fi
  echo "HASH_MISMATCH $url"
done
[ -n "$ok" ] || { echo "ERROR DOWNLOAD"; exit 21; }
mkdir -p "$TMP/x"
echo "PROGRESS runtime-extract"
tar -xzf "$TMP/node.tgz" -C "$TMP/x" --strip-components=1
install -d -m 755 ${INSTALL_DIR}
rm -rf "$NODE_DIR.new"
mv "$TMP/x" "$NODE_DIR.new"
chmod -R a+rX "$NODE_DIR.new"
rm -rf "$NODE_DIR"
mv "$NODE_DIR.new" "$NODE_DIR"
echo "NODE_READY $("$NODE_DIR/bin/node" --version)"
`;

const UPLOAD_SCRIPT = `
set -e
install -d -m 755 ${INSTALL_DIR}
umask 022
cat > ${INSTALL_DIR}/relay.new.mjs
echo "SHA $(sha256sum ${INSTALL_DIR}/relay.new.mjs | cut -d' ' -f1)"
`;

const CONFIGURE_SCRIPT = `
set -e
ADDRESS="$1"; LISTEN="$2"; PUBLIC_URL="$3"; REPLACE="$4"; ACME_DIRECTORY="$5"; MODE="$6"; PORT="$7"; CHALLENGE_PORT="$8"; shift 8
NODE=${INSTALL_DIR}/node/bin/node
if ! id cindy-relay >/dev/null 2>&1; then
  useradd --system --home-dir ${DATA_DIR} --no-create-home --shell /usr/sbin/nologin cindy-relay 2>/dev/null \\
    || useradd -r -d ${DATA_DIR} -s /sbin/nologin cindy-relay
fi
systemctl stop cindy-relay >/dev/null 2>&1 || true
if [ "$REPLACE" = 1 ]; then rm -rf ${DATA_DIR}; fi
install -d -m 700 -o cindy-relay -g cindy-relay ${DATA_DIR}
mv -f ${INSTALL_DIR}/relay.new.mjs ${INSTALL_DIR}/relay.mjs
if [ ! -f ${DATA_DIR}/relay-state.json ]; then
  "$NODE" ${INSTALL_DIR}/relay.mjs init --data ${DATA_DIR} "$@" >/dev/null
  echo "INITIALIZED"
fi
chown -R cindy-relay:cindy-relay ${DATA_DIR}
rm -f ${DATA_DIR}/status.json
EXTRA=""
CAPS=""
if [ "$MODE" != nginx-existing ]; then
  EXTRA=" --acme-identifier $ADDRESS --acme-http-port $CHALLENGE_PORT"
  if [ -n "$ACME_DIRECTORY" ]; then EXTRA="$EXTRA --acme-directory $ACME_DIRECTORY"; fi
fi
if [ "$MODE" != direct ]; then EXTRA="$EXTRA --trust-proxy"; fi
if [ "$MODE" = direct ]; then CAPS=CAP_NET_BIND_SERVICE; fi
cat > /etc/systemd/system/cindy-relay.service.new <<UNIT
[Unit]
Description=Cindy self-hosted relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cindy-relay
Group=cindy-relay
ExecStart=$NODE ${INSTALL_DIR}/relay.mjs serve --data ${DATA_DIR} --host $LISTEN --port $PORT --public-url $PUBLIC_URL$EXTRA
Restart=always
RestartSec=5
AmbientCapabilities=$CAPS
CapabilityBoundingSet=$CAPS
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
if [ "$MODE" = direct ]; then
  mv -f /etc/systemd/system/cindy-relay.service.new /etc/systemd/system/cindy-relay.service
else
  "$NODE" ${INSTALL_DIR}/relay.mjs nginx --action configure-service >/dev/null
  rm -f /etc/systemd/system/cindy-relay.service.new
fi
systemctl daemon-reload
systemctl enable cindy-relay >/dev/null 2>&1
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && echo "FIREWALL ufw"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null && echo "FIREWALL firewalld"
fi
systemctl restart cindy-relay
echo "CONFIGURED"
`;

const NGINX_SCRIPT = `
set -e
ACTION="$1"; shift
NODE=${INSTALL_DIR}/node/bin/node
BUNDLE=${INSTALL_DIR}/relay.mjs
if [ -f ${INSTALL_DIR}/relay.new.mjs ]; then BUNDLE=${INSTALL_DIR}/relay.new.mjs; fi
if [ "$ACTION" != commit ]; then "$NODE" "$BUNDLE" nginx --action "$ACTION" "$@"; fi
if [ "$ACTION" = rollback ]; then
  rm -f /etc/systemd/system/cindy-relay.service.new
  systemctl daemon-reload
  if [ -f /etc/systemd/system/cindy-relay.service ]; then systemctl restart cindy-relay
  else systemctl stop cindy-relay >/dev/null 2>&1 || true; fi
  if [ ! -f /etc/cindy-relay/nginx/state.json ]; then
    systemctl disable --now cindy-relay-nginx.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/cindy-relay-nginx.timer /etc/systemd/system/cindy-relay-nginx.service
  fi
fi
if [ "$ACTION" = commit ]; then
  cat > /etc/systemd/system/cindy-relay-nginx.service <<UNIT
[Unit]
Description=Apply renewed Cindy relay certificate to Nginx
[Service]
Type=oneshot
ExecStart=$NODE ${INSTALL_DIR}/relay.mjs nginx --action renew
UMask=0077
UNIT
  cat > /etc/systemd/system/cindy-relay-nginx.timer <<UNIT
[Unit]
Description=Check Cindy relay Nginx certificate
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now cindy-relay-nginx.timer >/dev/null 2>&1
  "$NODE" "$BUNDLE" nginx --action commit
fi
`;

const STATUS_SCRIPT = `
echo "ACTIVE $(systemctl is-active cindy-relay 2>/dev/null)"
if [ -f ${DATA_DIR}/status.json ]; then echo "STATUS $(cat ${DATA_DIR}/status.json)"; fi
`;

const JOURNAL_SCRIPT = `journalctl -u cindy-relay -n 15 --no-pager -o cat 2>/dev/null | tail -n 15`;

const UNINSTALL_SCRIPT = `
set -e
NODE=${INSTALL_DIR}/node/bin/node
STATE=${DATA_DIR}/relay-state.json
# 没有设备档案时只剩未完成部署留下的程序文件，无需核对主人；有档案就必须是本机这一份。
if [ -f "$STATE" ]; then
  if [ ! -x "$NODE" ]; then echo "RELAY_MISMATCH"; exit 22; fi
  "$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(s.relayId!==process.argv[2]||s.ownerPublicKey!==process.argv[3])process.exit(22)}catch{process.exit(22)}' "$STATE" "$2" "$3" || { echo "RELAY_MISMATCH"; exit 22; }
fi
if [ -f /etc/cindy-relay/nginx/state.json ]; then
  systemctl stop cindy-relay-nginx.timer cindy-relay-nginx.service >/dev/null 2>&1 || true
  "$NODE" ${INSTALL_DIR}/relay.mjs nginx --action remove
  systemctl disable cindy-relay-nginx.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cindy-relay-nginx.timer /etc/systemd/system/cindy-relay-nginx.service
fi
systemctl disable --now cindy-relay >/dev/null 2>&1 || true
rm -f /etc/systemd/system/cindy-relay.service /etc/systemd/system/cindy-relay.service.new
systemctl daemon-reload >/dev/null 2>&1 || true
rm -rf ${INSTALL_DIR}
if [ "$1" = 1 ]; then
  rm -rf ${DATA_DIR}
  userdel cindy-relay >/dev/null 2>&1 || true
fi
echo "UNINSTALLED"
`;

function nodeUrls(arch: 'x64' | 'arm64', preferMirror: boolean): [string, string] {
  const file = `node-v${NODE_VERSION}-linux-${arch}.tar.gz`;
  const official = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`;
  const mirror = `https://cdn.npmmirror.com/binaries/node/v${NODE_VERSION}/${file}`;
  return preferMirror ? [mirror, official] : [official, mirror];
}

/** 服务器自报的文字只用于显示:只留可打印字符并限长。 */
function displayText(value: string | undefined, max = 80): string {
  return [...(value ?? '')].filter((char) => char >= ' ' && char !== '\u007f').join('').trim().slice(0, max);
}

/** 连接并确认权限与系统;返回可用 root 执行的远端。 */
async function prepare(
  sshHostId: string,
  assertCurrent: () => void,
): Promise<{ remote: Remote; arch: 'x64' | 'arm64'; ipv6: boolean; system: string }> {
  const base = await connect(sshHostId, assertCurrent);
  const probe = parseLines((await base.plain(PROBE_SCRIPT, 'relay-deploy-probe')).stdout);
  // 连得上却一行都没跑出来:这个账号没有命令行(例如 Git 服务的 git 账号),不是系统不支持。
  if (!first(probe, 'OS')) throw new RelayDeployError('SHELL_UNAVAILABLE');
  const machine = first(probe, 'ARCH');
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
  if (first(probe, 'OS') !== 'Linux' || !arch || first(probe, 'SYSTEMD') !== 'yes') {
    throw new RelayDeployError('UNSUPPORTED_SYSTEM', `${first(probe, 'OS') ?? '?'} ${machine ?? '?'}`);
  }
  const privilege = first(probe, 'ROOT');
  if (privilege !== 'root' && privilege !== 'sudo') throw new RelayDeployError('NEEDS_ROOT');
  if (first(probe, 'FETCH') !== 'yes') throw new RelayDeployError('UNSUPPORTED_SYSTEM', 'curl / wget');
  const system = [displayText(first(probe, 'DISTRO')) || 'Linux', displayText(machine, 16)].join(' · ');
  return { remote: base.withPrivilege(privilege), arch, ipv6: first(probe, 'IPV6') === 'yes', system };
}

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * 80/443 的占用情况:系统里的 Nginx 自动接入;Docker 容器与其他程序都不碰,停下说明是谁占着。
 * 返回是否经已有 Nginx 接入。
 */
function assessPorts(inspected: Map<string, string[]>): boolean {
  const containers = new Set<string>();
  const programs = new Set<string>();
  let nginx = false;
  for (const line of inspected.get('BUSY') ?? []) {
    const owner = line.split(' ')[1] ?? '';
    if (owner === 'nginx') nginx = true;
    else if (owner.startsWith('docker:')) {
      const names = owner.slice('docker:'.length).split(',').filter((name) => CONTAINER_NAME.test(name));
      for (const name of names.length ? names : ['docker-proxy']) containers.add(name);
    } else programs.add(displayText(owner, 40) || '?');
  }
  if (containers.size) throw new RelayDeployError('PORT_BUSY_CONTAINER', [...containers].join(', '));
  if (programs.size) throw new RelayDeployError('PORT_BUSY', [...programs].join(', '));
  return nginx || first(inspected, 'NGINX_MANAGED') === 'yes';
}

function existingRelay(
  state: string | undefined,
  identity: { relayId: string; ownerPublicKey: string } | null,
): RelayServerCheck['existing'] {
  if (!state) return 'none';
  // 设备档案还在、Node 已被保留数据卸载移除时读不出身份;部署时会先恢复 Node 再核对。
  if (state === 'unknown') return identity ? 'mine' : 'other';
  const [, relayId, ownerPublicKey] = state.split(' ');
  return identity && relayId === identity.relayId && ownerPublicKey === identity.ownerPublicKey ? 'mine' : 'other';
}

/** 只读检查服务器能否部署:不安装、不写文件、不改配置。 */
export async function checkRelayServer(
  sshHostId: string,
  identity: { relayId: string; ownerPublicKey: string } | null,
  assertCurrent: () => void = () => {},
): Promise<RelayServerCheck> {
  const { remote, system } = await prepare(sshHostId, assertCurrent);
  const inspected = parseLines((await remote.root(INSPECT_SCRIPT, [], { label: 'relay-deploy-inspect' })).stdout);
  const plan = assessPorts(inspected) ? 'nginx' : 'direct';
  return { system, plan, existing: existingRelay(first(inspected, 'STATE'), identity) };
}

function expectOk(result: { exitCode: number | null; stdout: string; stderr: string }, code: RelayDeployErrorCode): Map<string, string[]> {
  const lines = parseLines(result.stdout);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    throw new RelayDeployError(code, reason || undefined);
  }
  return lines;
}

async function waitForCertificate(remote: Remote, onProgress?: (message: RelayDeployProgressMessage) => void): Promise<void> {
  const deadline = Date.now() + CERTIFICATE_WAIT_MS;
  // 只是暂时连不上 CA 时中转会自己重试:继续等,到时间仍连不上才报 CA_UNREACHABLE。
  let unreachable: string | null = null;
  let reportedAt: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CERTIFICATE_POLL_MS));
    const lines = parseLines((await remote.root(STATUS_SCRIPT, [], { label: 'relay-deploy-status' })).stdout);
    const active = first(lines, 'ACTIVE');
    type CertificateStatus = { state?: string; error?: string; transient?: boolean; updatedAt?: string };
    let certificate: CertificateStatus | undefined;
    try {
      certificate = (JSON.parse(first(lines, 'STATUS') ?? '{}') as { certificate?: CertificateStatus }).certificate;
    } catch {
      certificate = undefined;
    }
    if (certificate?.state === 'ready') return;
    if (certificate?.state === 'failed' && certificate.transient) {
      unreachable = certificate.error ?? 'certificate authority unreachable';
      if (certificate.updatedAt !== reportedAt) {
        reportedAt = certificate.updatedAt;
        onProgress?.('certificate-retry');
      }
    } else if (certificate?.state === 'failed') {
      throw new RelayDeployError('CERTIFICATE_FAILED', certificate.error?.slice(0, 400));
    }
    if (active === 'failed' || (active && active !== 'active' && active !== 'activating')) {
      const journal = (await remote.root(JOURNAL_SCRIPT, [], { label: 'relay-deploy-journal' })).stdout;
      const errorLine = journal
        .split('\n')
        .reverse()
        .find((line) => line.includes('"error"') || line.includes('Error'));
      throw new RelayDeployError('DEPLOY_FAILED', errorLine?.slice(0, 400));
    }
  }
  if (unreachable) throw new RelayDeployError('CA_UNREACHABLE', unreachable.slice(0, 400));
  throw new RelayDeployError('CERTIFICATE_FAILED', 'timed out waiting for the certificate');
}

async function verifyReachable(baseUrl: string, relayId: string, onRetry?: () => void): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) onRetry?.();
    try {
      const res = await fetch(`${baseUrl}/api/device-link/relay/info`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { relayId?: string };
      if (res.ok && body.relayId === relayId) return;
      lastError = `unexpected response (${res.status})`;
    } catch (error) {
      lastError = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new RelayDeployError('NOT_REACHABLE', lastError.slice(0, 300));
}

async function existingHttpsCertificate(baseUrl: string): Promise<boolean> {
  try {
    // 只验证 HTTPS 信任、地址与有效期；站点的 404/403 同样可以证明 TLS 可用。
    const response = await fetch(baseUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function nginxAction(remote: Remote, action: string, args: string[] = []): Promise<Record<string, unknown>> {
  const result = await remote.root(NGINX_SCRIPT, [action, ...args], {
    label: `relay-deploy-nginx-${action}`,
    timeoutMs: 120_000,
  });
  const event = result.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('{'));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(event ?? '{}') as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (result.exitCode !== 0 || parsed.event === 'error') {
    // Node 启动失败时 CLI 还来不及输出 JSON；只提取稳定错误码，避免原始 stderr 进入界面。
    const runtimeCode = /\[(ERR_[A-Z0-9_]{1,80})\]/.exec(result.stderr)?.[1];
    throw new RelayDeployError('NGINX_FAILED', typeof parsed.message === 'string' ? parsed.message.slice(0, 300) : runtimeCode);
  }
  return parsed;
}

/** 部署或升级:服务器上已有本机主人的中转时保留数据,只换程序与配置。 */
export async function deployRelayToServer(params: DeployParams): Promise<{ relayVersion: string }> {
  const bundlePath = resolveRelayBundlePath();
  if (!bundlePath) throw new RelayDeployError('BUNDLE_MISSING');
  const bundle = fs.readFileSync(bundlePath);

  params.onStep('check');
  const { remote, arch, ipv6 } = await prepare(params.sshHostId, params.assertCurrent ?? (() => {}));
  const inspected = parseLines((await remote.root(INSPECT_SCRIPT, [], { label: 'relay-deploy-inspect' })).stdout);
  const useNginx = assessPorts(inspected);
  const state = first(inspected, 'STATE');
  const assertExistingIdentity = (existingState: string) => {
    const [, relayId, ownerPublicKey] = existingState.split(' ');
    if (relayId !== params.init.relayId || ownerPublicKey !== params.init.ownerPublicKey) {
      throw new RelayDeployError('RELAY_MISMATCH');
    }
  };
  if (state && state !== 'unknown' && !params.replaceExisting) {
    assertExistingIdentity(state);
  }

  params.onServerChange?.();
  params.onStep('runtime');
  const [urlA, urlB] = nodeUrls(arch, params.preferMirror);
  const runtime = await remote.root(RUNTIME_SCRIPT, [NODE_VERSION, NODE_SHA256[arch], urlA, urlB], {
    timeoutMs: 20 * 60 * 1000,
    label: 'relay-deploy-runtime',
    onProgress: params.onProgress,
  });
  expectOk(runtime, 'DOWNLOAD_FAILED');

  // 保留数据卸载会移除 Node。恢复运行环境后重读身份，上传和配置仍须等身份匹配。
  if (state === 'unknown' && !params.replaceExisting) {
    const restored = parseLines((await remote.root(INSPECT_SCRIPT, [], { label: 'relay-deploy-inspect' })).stdout);
    const restoredState = first(restored, 'STATE');
    if (!restoredState) throw new RelayDeployError('RELAY_MISMATCH');
    assertExistingIdentity(restoredState);
  }

  params.onStep('upload');
  const uploaded = expectOk(
    await remote.root(UPLOAD_SCRIPT, [], {
      input: bundle,
      timeoutMs: 120_000,
      label: 'relay-deploy-upload',
    }),
    'DEPLOY_FAILED',
  );
  if (first(uploaded, 'SHA') !== createHash('sha256').update(bundle).digest('hex')) {
    throw new RelayDeployError('DEPLOY_FAILED', 'upload checksum mismatch');
  }

  params.onStep('configure');
  const init = params.init;
  const initArgs = [
    '--name',
    init.name,
    '--owner-user',
    init.ownerUserId,
    '--owner-device',
    init.ownerDeviceId,
    '--owner-device-name',
    init.ownerDeviceName,
    '--owner-credential-hash',
    init.ownerCredentialHash,
    '--relay-id',
    init.relayId,
    '--owner-public-key',
    init.ownerPublicKey,
    '--owner-cert',
    Buffer.from(JSON.stringify(init.ownerCert)).toString('base64url'),
  ];
  const acmeDirectory = process.env.CINDY_RELAY_ACME_DIRECTORY ?? '';
  let mode = 'direct';
  let port = 443;
  let challengePort = 80;
  let nginxPrepared = false;
  try {
    if (useNginx) {
      params.onProgress?.('nginx-prepare');
      const args = ['--address', params.address];
      if (ipv6) args.push('--ipv6');
      if (await existingHttpsCertificate(params.baseUrl)) args.push('--existing-certificate');
      const prepared = await nginxAction(remote, 'prepare', args);
      nginxPrepared = true;
      if (!Number.isInteger(prepared.port) || !Number.isInteger(prepared.challengePort)) throw new RelayDeployError('NGINX_FAILED');
      mode = prepared.existingCertificate ? 'nginx-existing' : 'nginx-acme';
      port = prepared.port as number;
      challengePort = prepared.challengePort as number;
    }
    const configured = await remote.root(
      CONFIGURE_SCRIPT,
      [
        params.address,
        useNginx ? '127.0.0.1' : ipv6 ? '::' : '0.0.0.0',
        params.baseUrl,
        params.replaceExisting ? '1' : '0',
        acmeDirectory,
        mode,
        String(port),
        String(challengePort),
        ...initArgs,
      ],
      { timeoutMs: 180_000, label: 'relay-deploy-configure' },
    );
    const configureLines = expectOk(configured, 'DEPLOY_FAILED');
    log.info('relay configured on server', {
      initialized: configureLines.has('INITIALIZED'),
      firewall: (configureLines.get('FIREWALL') ?? []).join(',') || 'none',
    });

    params.onStep('certificate');
    if (mode !== 'nginx-existing') {
      params.onProgress?.('certificate-wait');
      await waitForCertificate(remote, params.onProgress);
    }
    if (useNginx) await nginxAction(remote, 'activate');

    params.onStep('verify');
    await verifyReachable(params.baseUrl, init.relayId, () => params.onProgress?.('verify-retry'));
    if (useNginx) await nginxAction(remote, 'commit');
    return { relayVersion: RELAY_VERSION };
  } catch (error) {
    if (nginxPrepared) {
      params.onProgress?.('nginx-rollback');
      try {
        await nginxAction(remote, 'rollback');
      } catch {
        throw new RelayDeployError('NGINX_FAILED', 'Nginx rollback could not be completed; server configuration backup retained');
      }
    }
    throw error;
  }
}

export async function uninstallRelayFromServer(
  sshHostId: string,
  identity: { relayId: string; ownerPublicKey: string },
  removeData: boolean,
  onStep: (step: RelayDeployStep) => void,
  assertCurrent: () => void = () => {},
): Promise<void> {
  onStep('connect');
  const { remote } = await prepare(sshHostId, assertCurrent);
  const inspected = expectOk(await remote.root(INSPECT_SCRIPT, [], { label: 'relay-deploy-inspect' }), 'DEPLOY_FAILED');
  const state = first(inspected, 'STATE');
  if (state) {
    const [, relayId, ownerPublicKey] = state.split(' ');
    if (relayId !== identity.relayId || ownerPublicKey !== identity.ownerPublicKey) throw new RelayDeployError('RELAY_MISMATCH');
  }
  onStep('remove');
  const result = await remote.root(UNINSTALL_SCRIPT, [removeData ? '1' : '0', identity.relayId, identity.ownerPublicKey], {
    label: 'relay-deploy-uninstall',
  });
  if (parseLines(result.stdout).has('RELAY_MISMATCH')) throw new RelayDeployError('RELAY_MISMATCH');
  expectOk(result, 'DEPLOY_FAILED');
}
