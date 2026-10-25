import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { stripXdtFileLinks, stripXdtImageLinks } from '@cindy/im';
import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';

/**
 * 把 ScheduleRun 渲染成外部通知通用文案。
 *
 * 视觉布局（从上到下）:
 *   1. 状态标题 — `<emoji> <schedule name>` 加粗,emoji 据 status 区分
 *   2. （失败时）错误原因 — 截断到 200 字符
 *   3. 元信息 — 时间 · 耗时 · agent · 工作目录(短)
 *
 * 格式约束:
 *   - 仅使用飞书与企微群消息共同支持的 Markdown 子集：`**bold**`、列表、emoji
 *   - URL 直接写，由各渠道按自身能力识别
 *   - 不使用行内 code，避免渠道渲染与清洗规则产生差异
 */
export function renderExternalMessage(schedule: Schedule, run: ScheduleRun): string {
  const lines: string[] = [`${statusEmoji(run.status)} **${schedule.name}**`];

  if (run.status === 'failed' && run.errorMsg) {
    lines.push('', `⚠️ ${truncate(run.errorMsg, 200)}`);
  } else if (run.status === 'success' && run.resultText) {
    // prompt 类成功：把 agent 这一轮 turn 的最终文本贴出来 — 与飞书正常对话
    // 气泡显示同源（runner 按 text 事件 isFinal 语义聚合）。截断防卡片体积过大,
    // 完整内容用户可点 "Open session" 看。上限 6000:多 PR 审查汇总这类逐行带
    // markdown 链接的正文 1500 会拦腰截断;6000 即使全 CJK(~18KB UTF-8)也在
    // 飞书互动卡片 30KB 体积上限内。
    const safeResultText = stripXdtFileLinks(stripXdtImageLinks(run.resultText)).trim();
    if (safeResultText) lines.push('', truncate(safeResultText, 6000));
  }

  // ── 元信息行（时间 / 耗时 / agent / cwd）────────────────────────────────
  const metaParts: string[] = [];
  metaParts.push(`⏰ ${formatTime(run.firedAt)}`);
  if (typeof run.finishedAt === 'number' && run.finishedAt > run.firedAt) {
    metaParts.push(`⏱️ ${formatDuration(run.finishedAt - run.firedAt)}`);
  }
  metaParts.push(`🤖 ${schedule.agentKind}${schedule.model ? ` · ${schedule.model}` : ''}`);
  const wd = shortDir(schedule.workingDir);
  if (wd) metaParts.push(`📂 ${wd}`);
  lines.push('', metaParts.join('  ·  '));

  return lines.join('\n');
}

function statusEmoji(s: ScheduleRun['status']): string {
  switch (s) {
    case 'success': return '✅';
    case 'failed': return '❌';
    case 'aborted': return '⏹️';
    case 'interrupted': return '⏹️';
    case 'running': return '⏳';
    default: return 'ℹ️';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatTime(ms: number): string {
  // 飞书内本就显示当地时区,不再写 timezone;格式 5/9 15:46
  const d = new Date(ms);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatDuration(diffMs: number): string {
  if (diffMs < 1000) return `${diffMs}ms`;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function shortDir(p?: string): string | null {
  if (!p) return null;
  const segs = stripTrailingPathSeparators(p).split(/[\\/]/);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join('/')}`;
}
