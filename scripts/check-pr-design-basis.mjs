#!/usr/bin/env node
// PR 正文「设计依据」轻校验：当 PR 的变更命中 UI 路径时，要求正文「UI 变化」里的
// 「引用的设计规范」字段已经填写——要么引用 docs/design-rules/ 下的具体规范
// （如 DESIGN.md §某章节），要么写明「不涉及」并附理由（改动命中 UI 路径但确无
// 视觉/交互/文案变化时）。只做锚点、非空与引用格式检查，内容质量仍由人工 review
// 与内部 review-pr Skill 把关；本脚本不读取任何私有配置。
//
// CI 用法（由 .github/workflows/pr-design-basis.yml 调用）：
//   GITHUB_EVENT_PATH  pull_request 事件 payload（取 PR body、仓库与编号）
//   GITHUB_TOKEN       只读调用 GitHub API 拉取 PR 变更文件列表
// 本地调试（不访问网络）：
//   node scripts/check-pr-design-basis.mjs --body <body.md> --files <files.txt>
//   files.txt 为每行一个变更文件路径的文本文件。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// UI 路径启发式白名单：命中即视为「涉及 UI」。这是轻校验的判定边界，
// 有误报时作者可用「不涉及：<理由>」豁免；调整边界直接改这两个列表。
const UI_PATH_PREFIXES = [
  'apps/desktop/src/renderer/',
  'apps/mobile/app/',
  'apps/mobile/src/auth/',
  'apps/mobile/src/components/',
  'apps/mobile/src/i18n/',
  'apps/mobile/src/notifications/',
  'apps/mobile/src/session/',
  'apps/mobile/src/settings/',
  'apps/mobile/src/theme/',
];
const UI_FILE_SUFFIXES = ['.css', '.scss', '.less'];

const FIELD_LABEL = '引用的设计规范';
// 设计规范文档引用特征：docs/design-rules/ 目录或其下具体文档名。
const DESIGN_DOC_PATTERN =
  /(docs\/design-rules\/|DESIGN\.md|cindy-design-system|figma-component-spec|token-decision-table)/i;
// 「不涉及」豁免在去掉该词与标点后至少要剩这么多字符，才算附了理由
// （放到 4 是为了让「纯逻辑重构」「无 UI 变化」这类最短合理理由能过）。
const MIN_EXEMPT_REASON_CHARS = 4;
// 任务清单行（如模板「提交前检查」的勾选项）不算字段锚点：其文案里同时含有
// 字段标签与「不涉及」，若被当成字段内容会造成假通过。
const CHECKLIST_LINE_PATTERN = /^\s*[-*+]\s*\[[ xX]\]/;

export function isUiPath(path) {
  return (
    UI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    UI_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  );
}

/** 提取「引用的设计规范」字段正文：从标签行到下一个 Markdown 标题为止。 */
export function extractDesignBasis(body) {
  // 先剥掉 HTML 注释，避免模板自带的填写说明（含规范文件名）造成假通过。
  const stripped = body.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split(/\r?\n/);
  const labelIndex = lines.findIndex(
    (line) => line.includes(FIELD_LABEL) && !CHECKLIST_LINE_PATTERN.test(line)
  );
  if (labelIndex === -1) return null;

  const labelLine = lines[labelIndex];
  const afterLabel = labelLine.slice(labelLine.indexOf(FIELD_LABEL) + FIELD_LABEL.length);
  const parts = [afterLabel.replace(/^[\s:：]+/, '')];
  for (let i = labelIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    parts.push(lines[i]);
  }
  return parts.join('\n').trim();
}

/** 返回错误列表；空列表即通过。uiFiles 为命中 UI 路径的变更文件。 */
export function validateDesignBasis(body, uiFiles) {
  if (uiFiles.length === 0) return [];

  const errors = [];
  const content = typeof body === 'string' ? extractDesignBasis(body) : null;

  if (content === null) {
    errors.push(
      `PR 正文缺少「${FIELD_LABEL}」字段：请按 .github/PULL_REQUEST_TEMPLATE.md` +
        '「UI 变化」小节补齐（改动命中了 UI 路径）。'
    );
    return errors;
  }
  if (content === '') {
    errors.push(`「${FIELD_LABEL}」未填写：改动命中 UI 路径时该字段必填。`);
    return errors;
  }

  if (DESIGN_DOC_PATTERN.test(content)) return errors;

  if (content.includes('不涉及')) {
    const reason = content.replace(/不涉及/g, '').replace(/[\s、，,。.：:；;！!？?()（）-]/g, '');
    if (reason.length < MIN_EXEMPT_REASON_CHARS) {
      errors.push(
        '改动命中 UI 路径却填「不涉及」时必须附理由，' +
          '如「不涉及：纯逻辑重构，无视觉/交互/文案变化」。'
      );
    }
    return errors;
  }

  errors.push(
    `「${FIELD_LABEL}」需引用 docs/design-rules/ 下的具体规范章节` +
      '（如「DESIGN.md §间距与栅格：卡片内边距 16px」），' +
      '或在确无 UI 变化时写「不涉及：<理由>」。'
  );
  return errors;
}

async function fetchChangedFiles(repo, prNumber, token) {
  const files = [];
  // GitHub 列表 API 上限 3000 个文件，per_page=100 时最多 30 页。
  for (let page = 1; page <= 30; page += 1) {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`拉取 PR 变更文件列表失败：HTTP ${res.status}`);
    const batch = await res.json();
    for (const file of batch) files.push(file.filename);
    if (batch.length < 100) break;
  }
  return files;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  let body;
  let changedFiles;

  const bodyPath = readArg('--body');
  const filesPath = readArg('--files');
  if (bodyPath || filesPath) {
    if (!bodyPath || !filesPath) throw new Error('本地调试需同时提供 --body 与 --files。');
    body = readFileSync(bodyPath, 'utf8');
    changedFiles = readFileSync(filesPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error('缺少 GITHUB_EVENT_PATH（本脚本需在 pull_request 事件下运行）。');
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (!pr) throw new Error('事件 payload 中没有 pull_request，请检查 workflow 触发配置。');
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('缺少 GITHUB_TOKEN，无法拉取 PR 变更文件列表。');
    body = pr.body ?? '';
    changedFiles = await fetchChangedFiles(event.repository.full_name, pr.number, token);
  }

  const uiFiles = changedFiles.filter(isUiPath);
  if (uiFiles.length === 0) {
    console.log('变更未命中 UI 路径，跳过设计依据校验。');
    return;
  }

  const errors = validateDesignBasis(body, uiFiles);
  if (errors.length > 0) {
    console.error('PR 设计依据校验未通过：');
    for (const error of errors) console.error(`- ${error}`);
    console.error('\n命中 UI 路径的变更文件（最多列 20 个）：');
    for (const file of uiFiles.slice(0, 20)) console.error(`- ${file}`);
    if (uiFiles.length > 20) console.error(`- …另有 ${uiFiles.length - 20} 个`);
    process.exit(1);
  }

  console.log(`设计依据校验通过（命中 UI 路径的变更文件 ${uiFiles.length} 个）。`);
}

// 仅作为入口执行时运行；被 import 时只导出纯函数，便于本地测试。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
