/**
 * 读 SSH 主机此刻的资源（docs/product-rules/cindy-machines.md）。命令写死、只读、不接受任何输入，
 * 所以和读本机状态一样不走 ssh_exec 的审批。读不到的项是 null，不用近似值冒充。
 */
import type { MachineStatus } from '@cindy/device-link';

export const SSH_STATUS_COMMAND = [
  'os=$(uname -s); echo "os=$os"; echo "arch=$(uname -m)"',
  'if [ "$os" = Darwin ]; then',
  'echo "cores=$(sysctl -n hw.logicalcpu)"; echo "memTotal=$(sysctl -n hw.memsize)"; vm_stat',
  'set -- $(sysctl -n vm.loadavg); echo "load=$2"',
  'else',
  'echo "cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached):" /proc/meminfo',
  'read -r load _ < /proc/loadavg; echo "load=$load"',
  'fi',
  // 不用 awk：macOS 的 /bin/sh 解析不了命令替换里嵌套的引号。
  'set -- $(df -Pk "$HOME" | tail -1); echo "disk=$2 $4"',
].join('\n');

/** macOS 的 os.freemem() 只算完全空闲的页，不含可回收的缓存，会把健康的电脑读成内存见底。 */
export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(output)?.[1]);
  const available = (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
  return Number.isFinite(available) ? available : null;
}

const value = (output: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(output)?.[1]?.trim() ?? '';
const kb = (output: string, key: string) => {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(output);
  return match ? Number(match[1]) * 1024 : null;
};
const positive = (text: string) => { const parsed = Number(text); return text && Number.isFinite(parsed) && parsed > 0 ? parsed : null; };

function linuxAvailable(output: string): number | null {
  const direct = kb(output, 'MemAvailable');
  if (direct !== null) return direct;
  const parts = [kb(output, 'MemFree'), kb(output, 'Buffers'), kb(output, 'Cached')];
  return parts.every((part): part is number => part !== null) ? parts.reduce((sum, part) => sum + part, 0) : null;
}

export interface SshHostStatus { os: string; arch: string; status: MachineStatus }

/** null：那台不是能跑这段命令的系统（例如 Windows 的 OpenSSH），或输出认不出来。 */
export function parseSshStatus(output: string, now = new Date()): SshHostStatus | null {
  const os = value(output, 'os');
  const cores = positive(value(output, 'cores'));
  const totalBytes = os === 'Darwin' ? positive(value(output, 'memTotal')) : kb(output, 'MemTotal');
  if (!os || !cores || !totalBytes) return null;
  const [diskTotal, diskFree] = value(output, 'disk').split(/\s+/).map(Number);
  return {
    os,
    arch: value(output, 'arch'),
    status: {
      capturedAt: now.toISOString(),
      cpu: { logicalCores: cores, busyPercent: null, loadAverage1m: Number.isFinite(parseFloat(value(output, 'load'))) ? parseFloat(value(output, 'load')) : null },
      memory: { totalBytes, availableBytes: os === 'Darwin' ? parseVmStatAvailableBytes(output) : linuxAvailable(output) },
      disk: Number.isFinite(diskTotal) && Number.isFinite(diskFree) ? { freeBytes: diskFree! * 1024, totalBytes: diskTotal! * 1024 } : null,
      idleSeconds: null,
      onBattery: null,
      runningTasks: null,
    },
  };
}
