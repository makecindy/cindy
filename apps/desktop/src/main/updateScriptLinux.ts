/**
 * updateScriptLinux — pure builder for the Linux .deb update-apply bash script.
 *
 * Linux has no cindy-updater binary. After the Electron process exits, this
 * script asks polkit (pkexec) to install the staged .deb over the existing
 * package, then relaunches the same executable path.
 *
 * Extracted so the generated script can be regression-tested without Electron.
 */

export interface LinuxUpdateScriptTimings {
  /** Seconds to wait for the old PID before escalating to SIGKILL. */
  exitKillAfterSeconds: number;
  /** Seconds after which a PID that survived SIGKILL aborts the update. */
  exitAbortAfterSeconds: number;
  /** Total seconds to poll for the relaunched main process. */
  verifyTimeoutSeconds: number;
  /** Second at which relaunch is retried (only if the first launch failed). */
  verifyRetryAtSeconds: number;
  /** Seconds between lock-file heartbeats while pkexec may be waiting. */
  lockHeartbeatSeconds: number;
}

export const DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS: LinuxUpdateScriptTimings = {
  exitKillAfterSeconds: 120,
  exitAbortAfterSeconds: 135,
  verifyTimeoutSeconds: 30,
  verifyRetryAtSeconds: 15,
  lockHeartbeatSeconds: 5,
};

export interface LinuxUpdateScriptParams {
  /** PID of the exiting app process the script must wait for. */
  pid: number;
  /** Absolute path of the downloaded .deb. */
  debPath: string;
  /** Manifest SHA-256 of the staged .deb, rechecked immediately before pkexec. */
  sha256: string;
  /** Manifest size of the staged .deb, used to bound the elevated copy. */
  sizeBytes: number;
  /** Absolute path of the installed main binary to relaunch. */
  exePath: string;
  /** Update lock file the bootstrap spins on during the swap. */
  lockFilePath: string;
  /** cindy-update.log path. */
  logPath: string;
  timings?: Partial<LinuxUpdateScriptTimings>;
}

/** POSIX single-quote so paths cannot break out of the generated script. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * pgrep -f treats its pattern as an ERE — escape metacharacters so the
 * installed binary path matches literally.
 */
export function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 拉起验证按启动的子 PID(kill -0)而不是 pgrep:等锁的旧实例进程名
 * 也是 Cindy,按名字会把「更新前就启动的等待者」误判成新版本。
 */

export function normalizeLinuxDebSha256(value: string): string | null {
  const hex = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function buildLinuxUpdateScript(params: LinuxUpdateScriptParams): string {
  const { pid, debPath, exePath, lockFilePath, logPath } = params;
  const sha256 = normalizeLinuxDebSha256(params.sha256);
  if (!sha256) {
    throw new Error('Linux update script requires a 64-char sha256 of the staged .deb');
  }
  const sizeBytes = Math.max(1, Math.floor(params.sizeBytes));
  if (!Number.isFinite(sizeBytes)) {
    throw new Error('Linux update script requires a finite deb size');
  }
  const t = { ...DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS, ...params.timings };
  const qLog = shellSingleQuote(logPath);
  const qDeb = shellSingleQuote(debPath);
  const qExe = shellSingleQuote(exePath);
  const qLock = shellSingleQuote(lockFilePath);
  const qSha = shellSingleQuote(sha256);

  return [
    '#!/bin/bash',
    'set -u',
    // 先接管更新锁、启动心跳,再碰任何外部路径——日志若被替换成
    // FIFO 会让 append 永久阻塞,锁和心跳必须在阻塞之前就位,否则
    // bootstrap 会在 20s 后把「持有者已死的锁」当死锁清掉。
    `echo updating $$ > ${qLock}`,
    'LOCK_PARENT=$$',
    'LOCK_PGID=$$',
    `INSTALL_PID_FILE=${qLock}.install`,
    // 进程组扫描(输出落文件再逐行读,pgrep 自排除自身,心跳辅助进程不会
    // 误计;pkexec 已死但其孤儿 apt/dpkg 后代仍在组里,会被扫到)。
    // 组文件用 mktemp 建私有随机临时文件,不用可预测的 <lock>.group 路径——
    // 该路径被占位成目录或父目录不可写时,`pgrep > file` 会失败;此时必须
    // fail closed(当作「安装链可能还在」),绝不能把锁清掉让新 Cindy 在
    // apt 还在替换文件时启动。
    'scan_group_others() {',
    `    GROUPFILE=$(mktemp "\${TMPDIR:-/tmp}/cindy-group.XXXXXX") 2>/dev/null || { OTHERS=1; return 0; }`,
    `    if ! pgrep -g "$LOCK_PGID" > "$GROUPFILE" 2>/dev/null; then`,
    '        rm -f "$GROUPFILE"',
    '        OTHERS=1',
    '        return 0',
    '    fi',
    '    OTHERS=0',
    '    while read -r GPID; do',
    '        [ -z "$GPID" ] && continue',
    '        [ "$GPID" = "$BASHPID" ] && continue',
    '        [ "$GPID" = "$LOCK_PARENT" ] && continue',
    '        [ -n "${LOCK_HEARTBEAT_PID:-}" ] && [ "$GPID" = "$LOCK_HEARTBEAT_PID" ] && continue',
    '        OTHERS=1',
    '        break',
    `    done < "$GROUPFILE"`,
    '    rm -f "$GROUPFILE"',
    '}',
    // 拉起的新进程必须脱离本进程组(setsid),否则会被 scan_group_others',
    // 当成「仍在安装」,心跳和锁永远清不掉,新 Cindy 也会卡在等锁。',
    // 先等心跳真正退出再清锁:kill 只是发信号,不保证进程已死;bash 在
    // 前台等待 sleep 时会推迟处理 SIGTERM,若此刻直接 rm 锁,心跳醒来后
    // 仍可能再写一次锁,让新拉起的 Cindy 卡在等锁。wait 收口这个窗口。
    'relaunch_app() {',
    `    kill "$LOCK_HEARTBEAT_PID" 2>/dev/null`,
    `    wait "$LOCK_HEARTBEAT_PID" 2>/dev/null`,
    '    rm -f "$INSTALL_PID_FILE"',
    `    rm -f ${qLock}`,
    `    setsid nohup ${qExe} >/dev/null 2>&1 &`,
    '    LAUNCHED_PID=$!',
    '}',
    '(',
    '    while true; do',
    '        if kill -0 "$LOCK_PARENT" 2>/dev/null; then',
    `            echo updating "$LOCK_PARENT" > ${qLock}`,
    `            sleep ${t.lockHeartbeatSeconds}`,
    '            continue',
    '        fi',
    '        # 父 bash 死了。安装链是否还在,看本进程组里除自己和父之外',
    '        # 还有没有活成员。',
    '        scan_group_others',
    '        if [ "$OTHERS" -eq 1 ]; then',
    '            # 用 $BASHPID 写锁:子 shell 里 $$ 仍是父 shell 的 PID,',
    '            # 写它等于宣告一个已死的持有者。',
    `            echo updating "$BASHPID" > ${qLock}`,
    `            sleep ${t.lockHeartbeatSeconds}`,
    '            continue',
    '        fi',
    '        # 父死且组内没有别的成员:确实没有人在替换文件,清锁退出。',
    '        rm -f "$INSTALL_PID_FILE"',
    `        rm -f ${qLock}`,
    '        exit 0',
    '    done',
    ') &',
    'LOCK_HEARTBEAT_PID=$!',
    'cleanup() {',
    '    # 收到可捕获信号时,先扫进程组:pkexec 已死但其提权 Bash /',
    '    # apt-get / dpkg 后代仍在覆盖安装时,锁和心跳都留下,由心跳接管。',
    '    # 心跳自己已被排除在扫描外,不会让 cleanup 误判成「还有别人」。',
    '    scan_group_others',
    '    if [ "$OTHERS" -eq 1 ]; then',
    '        return',
    '    fi',
    '    kill "$LOCK_HEARTBEAT_PID" 2>/dev/null',
    '    wait "$LOCK_HEARTBEAT_PID" 2>/dev/null',
    '    rm -f "$INSTALL_PID_FILE"',
    `    rm -f ${qLock}`,
    '}',
    'trap cleanup EXIT',
    '',
    `echo "[$(date)] Update script started, waiting for PID ${pid}" >> ${qLog}`,
    `echo "[$(date)] deb=${qDeb} exe=${qExe}" >> ${qLog}`,
    '',
    'WAITED=0',
    `while kill -0 ${pid} 2>/dev/null; do`,
    '    sleep 1',
    '    WAITED=$((WAITED+1))',
    `    if [ "$WAITED" -eq ${t.exitKillAfterSeconds} ]; then`,
    `        echo "[$(date)] PID ${pid} still alive after ${t.exitKillAfterSeconds}s — exit appears hung, sending SIGKILL" >> ${qLog}`,
    `        kill -9 ${pid} 2>/dev/null`,
    '    fi',
    `    if [ "$WAITED" -ge ${t.exitAbortAfterSeconds} ]; then`,
    `        echo "[$(date)] FATAL: PID ${pid} survived SIGKILL — aborting update" >> ${qLog}`,
    '        exit 1',
    '    fi',
    'done',
    `echo "[$(date)] Process ${pid} exited, waiting for filesystem to settle" >> ${qLog}`,
    'sleep 2',
    '',
    'PKEXEC=/usr/bin/pkexec',
    'if [ ! -x "$PKEXEC" ]; then',
    '    PKEXEC=$(command -v pkexec 2>/dev/null || true)',
    'fi',
    'if [ -z "$PKEXEC" ] || [ ! -x "$PKEXEC" ]; then',
    `    echo "[$(date)] FATAL: pkexec not found — cannot install .deb" >> ${qLog}`,
    '    relaunch_app',
    '    exit 1',
    'fi',
    '',
    `if [ ! -f ${qDeb} ]; then`,
    `    echo "[$(date)] FATAL: staged .deb missing before install" >> ${qLog}`,
    '    relaunch_app',
    '    exit 1',
    'fi',
    // 提权边界校验:整个「复制 → 哈希 → 安装」都在同一个 root shell 里完成。
    // .deb 先拷进 root 自有的 0700 临时目录,哈希与安装读的是同一份 root 所有
    // 的副本,用户侧进程无法在哈希后换包;期望摘要与路径经 argv 传入。
    // 提权 shell 只写 stdout/stderr,由外层用户 shell 重定向到日志——
    // root 自己从不打开用户可替换的日志路径(符号链接攻击面)。
    'ELEVATED=\'set -eu',
    'TMP=$(mktemp -d "${TMPDIR:-/tmp}/cindy-deb.XXXXXX")',
    'chmod 700 "$TMP"',
    'cleanup_e() { rm -rf "$TMP"; }',
    'trap cleanup_e EXIT',
    // 快速失败检查;权威防线是下面的 dd nofollow 原子打开。
    'if [ -L "$2" ] || [ ! -f "$2" ]; then',
    '    echo "staged package is not a regular file" >&2',
    '    exit 1',
    'fi',
    // 原子打开:O_NOFOLLOW 拒绝符号链接(ELOOP),O_NONBLOCK 让 FIFO
    // 立即失败而不是挂起。count 按清单大小封顶,字符设备(如 /dev/zero)
    // 也只会读 预期大小+2MiB,随后的大小/哈希校验兜底。
    'CAP=$(( ($3 / 1048576) + 2 ))',
    'dd if="$2" of="$TMP/update.deb" iflag=nofollow,nonblock bs=1048576 count="$CAP" 2>/dev/null',
    'WRITTEN=$(stat -c %s "$TMP/update.deb")',
    'if [ "$WRITTEN" != "$3" ]; then',
    '    echo "size mismatch: expected $3 got $WRITTEN" >&2',
    '    exit 1',
    'fi',
    `ACTUAL=$(sha256sum "$TMP/update.deb" | awk "{print \\$1}")`,
    'if [ "$ACTUAL" != "$1" ]; then',
    '    echo "sha256 mismatch: expected $1 got $ACTUAL" >&2',
    '    exit 1',
    'fi',
    'if [ -x /usr/bin/apt-get ]; then',
    '    apt-get install --yes --allow-downgrades "$TMP/update.deb"',
    'elif [ -x /usr/bin/dpkg ]; then',
    '    dpkg --install "$TMP/update.deb"',
    'else',
    '    exit 127',
    'fi\'',
    '',
    `echo "[$(date)] invoking elevated installer via pkexec" >> ${qLog}`,
    `"$PKEXEC" /bin/bash -c "$ELEVATED" bash ${qSha} ${qDeb} ${sizeBytes} >> ${qLog} 2>&1 &`,
    'INSTALL_PID=$!',
    `echo "$INSTALL_PID" > "$INSTALL_PID_FILE"`,
    'wait "$INSTALL_PID"',
    'INSTALL_EXIT=$?',
    'rm -f "$INSTALL_PID_FILE"',
    `echo "[$(date)] install exit code: $INSTALL_EXIT" >> ${qLog}`,
    '',
    'if [ "$INSTALL_EXIT" -ne 0 ]; then',
    `    echo "[$(date)] INSTALL FAILED — relaunching previous binary" >> ${qLog}`,
    '    relaunch_app',
    '    exit 1',
    'fi',
    '',
    `echo "[$(date)] Starting app: ${qExe}" >> ${qLog}`,
    // 先杀心跳、放锁,再 setsid 拉起:新进程不在本进程组里,不会
    // 被 scan_group_others 误判成安装链,也不会卡在自己的锁上。
    'relaunch_app',
    'OPEN_EXIT=$?',
    `echo "[$(date)] relaunch spawn exit code: $OPEN_EXIT" >> ${qLog}`,
    '',
    'VERIFIED=0',
    'sleep 2',
    `for i in $(seq 1 ${t.verifyTimeoutSeconds}); do`,
    // 按启动的子 PID 验证(kill -0),不用 pgrep 按进程名找:等锁的旧实例
    // 进程名同样是 Cindy,会把它误判成更新后的进程;updater 自己的
    // bash -c 也永远匹配不上这个子 PID。
    `    if kill -0 "$LAUNCHED_PID" 2>/dev/null; then`,
    '        VERIFIED=1',
    '        break',
    '    fi',
    `    if [ "$i" -eq ${t.verifyRetryAtSeconds} ]; then`,
    `        echo "[$(date)] still not up after ${t.verifyRetryAtSeconds}s — retrying relaunch" >> ${qLog}`,
    `        setsid nohup ${qExe} >/dev/null 2>&1 &`,
    '        LAUNCHED_PID=$!',
    '    fi',
    '    sleep 1',
    'done',
    'if [ "$VERIFIED" -eq 1 ]; then',
    `    echo "[$(date)] PROCESS VERIFIED: launched pid $LAUNCHED_PID is running" >> ${qLog}`,
    'else',
    `    echo "[$(date)] WARNING: relaunch not verified within ${t.verifyTimeoutSeconds}s" >> ${qLog}`,
    'fi',
    '',
    `echo "[$(date)] Update script finished" >> ${qLog}`,
  ].join('\n') + '\n';
}
