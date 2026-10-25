/**
 * portReclaim.ts — loopback 固定端口的占用检测与自动回收。
 * ---------------------------------------------------------------------------
 * 场景:意识 OAuth 声明了 redirectPort(如 xd-atlassian 钉死 53682)时,回调
 * 端口被外部进程占用会让授权直接 LISTEN_FAILED。产品决策(2026-07-14 与
 * Lizi):点「连接」遇占用不再让用户自己去杀进程,主机自动查出占用者并强杀,
 * 然后重试监听——rclone 这类同端口默认值的工具属于可接受的误伤面。
 *
 * 与 ghostOauthFlow 的分工:flow 引擎只认注入的 `reclaimPort` 回调(规则 14,
 * 单测零 child_process);本模块是生产实现,负责平台差异:
 * - Windows:`netstat -ano` 找 LISTENING 行取 PID → `taskkill /T /F`;
 * - macOS / Linux:`lsof -iTCP:<port> -sTCP:LISTEN -Fpn` 取 PID → SIGKILL。
 * 门控在接线层:只有第一方官方意识的授权流会拿到本回收器(第三方 manifest
 * 可声明任意端口,放开等于借「连接账号」强杀用户本地服务)。
 *
 * 安全护栏(不可妥协):
 * - 只杀**真的会挡住 `127.0.0.1:<port>` bind** 的监听:本地地址必须是
 *   127.0.0.1 / 通配(0.0.0.0、[::])/ v6 环回([::1]);绑 LAN IP
 *   (192.168.x 等)的监听根本不挡 loopback bind,绝不列为候选;
 * - 绝不杀自己(process.pid)——自家在途监听由 flow 引擎在代码内自愈,走到
 *   这里还占着说明是别的实例/程序;若查出来是自己,宁可失败也不能自尽;
 * - 绝不杀系统级 PID(<= 4:Windows 的 Idle/System,POSIX 的 init 域)。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortReclaimLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** netstat/lsof 输出解析上限,防异常输出撑爆(正常输出远小于此)。 */
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 判定一条 LISTEN 记录的本地地址是否会挡住 `127.0.0.1:<port>` 的 bind,并给
 * 出候选优先级(越小越像真占用者):127.0.0.1 精确 > v4/v6 通配 > v6 环回。
 * 不挡路的(LAN IP 等)返回 null——netstat 全量输出里它们可能排在真占用者
 * 前面,按行序取第一条会杀错无辜进程。
 */
function rankBlockingLocalAddress(local: string, port: number): number | null {
  const suffix = `:${port}`;
  if (!local.endsWith(suffix)) return null;
  const host = local.slice(0, -suffix.length);
  switch (host) {
    case '127.0.0.1':
      return 0;
    case '0.0.0.0':
    case '*':
      return 1;
    case '[::]':
    case '::':
      return 2;
    case '[::1]':
    case '::1':
      return 3;
    default:
      return null;
  }
}

/** 从 {rank, pid} 候选集中取最优 rank 的去重 PID 列表。 */
function pickBestRankPids(candidates: Array<{ rank: number; pid: number }>): number[] {
  if (candidates.length === 0) return [];
  const best = Math.min(...candidates.map((c) => c.rank));
  return [...new Set(candidates.filter((c) => c.rank === best).map((c) => c.pid))];
}

/**
 * 查出正在 LISTEN 指定 TCP 端口、且会挡住 loopback bind 的进程 PID 列表
 * (通常一个;SO_REUSEPORT 多进程共听时多个)。查不到(端口已空闲/查询
 * 工具不可用)返回空数组。只认 LISTEN 态,不误伤恰好以该端口为源端口的连接。
 */
export async function findPortOwnerPids(port: number): Promise<number[]> {
  try {
    const candidates: Array<{ rank: number; pid: number }> = [];
    if (process.platform === 'win32') {
      // -a 全部连接 -n 数字形态 -o 带 PID(TCP v4/v6 行都以 "TCP" 开头)。
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        windowsHide: true,
        maxBuffer: OUTPUT_MAX_BYTES,
      });
      for (const line of stdout.split(/\r?\n/)) {
        // 形如:TCP    127.0.0.1:53682    0.0.0.0:0    LISTENING    1234
        const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (!m) continue;
        const rank = rankBlockingLocalAddress(m[1], port);
        const pid = Number(m[2]);
        if (rank !== null && Number.isInteger(pid) && pid > 0) candidates.push({ rank, pid });
      }
    } else {
      // -Fpn 机器格式:p<PID> 行后跟若干 n<本地地址> 行;-sTCP:LISTEN 已滤
      // 出监听态。无匹配时 lsof 以非零码退出(进 catch 折叠成空结果)。
      const { stdout } = await execFileAsync(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
        { maxBuffer: OUTPUT_MAX_BYTES },
      );
      let currentPid: number | null = null;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          const pid = Number(line.slice(1));
          currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
        } else if (line.startsWith('n') && currentPid !== null) {
          const rank = rankBlockingLocalAddress(line.slice(1).trim(), port);
          if (rank !== null) candidates.push({ rank, pid: currentPid });
        }
      }
    }
    return pickBestRankPids(candidates);
  } catch {
    return [];
  }
}

/** 强杀进程(Windows 连子进程树);护栏内的 PID 一律拒杀返回 false。 */
export async function killPortOwner(pid: number, logger?: PortReclaimLogger): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) {
    logger?.warn('port reclaim 拒绝强杀受保护 PID', { pid, self: process.pid });
    return false;
  }
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (err) {
    logger?.warn('port reclaim 强杀失败', { pid, err: String(err) });
    return false;
  }
}

/**
 * 一次完整回收:查占用 → 逐个强杀最优先候选。返回 true = 有理由重试 listen
 * (至少杀掉一个占用者,或查询时端口已空闲——占用者刚好自己退了);false =
 * 回收失败(受保护 PID / 杀不动,调用方按占用失败收场)。
 */
export async function reclaimLoopbackPort(port: number, logger?: PortReclaimLogger): Promise<boolean> {
  const pids = await findPortOwnerPids(port);
  if (pids.length === 0) {
    // 查不到占用者:可能已释放,也可能查询工具不可用——都值得让调用方重试一次。
    logger?.info('port reclaim 未查到占用进程,直接重试监听', { port });
    return true;
  }
  let killedAny = false;
  for (const pid of pids) {
    const killed = await killPortOwner(pid, logger);
    if (killed) {
      killedAny = true;
      logger?.info('port reclaim 已强杀占用进程', { port, pid });
    }
  }
  return killedAny;
}
