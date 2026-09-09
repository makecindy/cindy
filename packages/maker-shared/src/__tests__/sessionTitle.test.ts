import { describe, it, expect } from 'vitest';

import {
  DEFAULT_DRAFT_SESSION_TITLE,
  deriveOptimisticSessionTitle,
  isDefaultDraftSessionTitle,
  normalizeAutoTitle,
  projectDraftSessionTitle,
} from '../sessionTitle.js';

describe('normalizeAutoTitle', () => {
  it('折叠空白 → trim → 截断 40 字(先 trim 再截断)', () => {
    expect(normalizeAutoTitle('  帮我\n排查  登录失败 ')).toBe('帮我 排查 登录失败');
    expect(normalizeAutoTitle(`\n${' '.repeat(50)}real text`)).toBe('real text');
    expect(normalizeAutoTitle('排'.repeat(60))).toBe('排'.repeat(40));
    expect(normalizeAutoTitle('   ')).toBe('');
  });

  it('幂等:对已归一化的串再跑一次结果不变', () => {
    // renderer 的乐观预览与 main 的权威占位都跑这个函数,两次结果必须逐字一致 ——
    // 否则回流时侧边栏标题会跳变一次。
    const once = normalizeAutoTitle('  帮我\n排查  登录失败 ');
    expect(normalizeAutoTitle(once)).toBe(once);
  });

  it('先 trim 的串与原串算出同一个结果', () => {
    // 权威路径会先经 projectLiteralUserText / stripMentionTokens(两者都只 trim),
    // 乐观预览直接拿原文;两条输入必须收敛到同一个标题。
    const raw = '   帮我排查登录失败   ';
    expect(normalizeAutoTitle(raw.trim())).toBe(normalizeAutoTitle(raw));
  });
});

describe('isDefaultDraftSessionTitle', () => {
  it('只认建会话时的裸默认哨兵', () => {
    expect(isDefaultDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE)).toBe(true);
    expect(isDefaultDraftSessionTitle('帮我排查登录失败')).toBe(false);
    expect(isDefaultDraftSessionTitle('')).toBe(false);
    expect(isDefaultDraftSessionTitle(null)).toBe(false);
    expect(isDefaultDraftSessionTitle(undefined)).toBe(false);
  });

  it('不做大小写 / 空白归一 —— 用户改成近似串是合法自定义标题', () => {
    // 归一化比较会把用户手动改的名误判成系统占位,进而被自动起名覆盖掉。
    expect(isDefaultDraftSessionTitle('new maker')).toBe(false);
    expect(isDefaultDraftSessionTitle('NEW MAKER')).toBe(false);
    expect(isDefaultDraftSessionTitle(' New Maker ')).toBe(false);
  });

  it('哨兵值保持 locale-independent 字面量', () => {
    // 它是 SQLite 列默认值,又要跨设备 / 跨语言逐字比对,还是条件写的期望值。
    // 本地化会让哨兵匹配失效、自动起名永久跳过。
    expect(DEFAULT_DRAFT_SESSION_TITLE).toBe('New Maker');
  });
});

describe('projectDraftSessionTitle', () => {
  it('哨兵 + 已解析文案 → 换成那个文案', () => {
    expect(projectDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE, '未命名任务')).toBe('未命名任务');
    expect(projectDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE, 'Untitled session')).toBe('Untitled session');
  });

  it('非哨兵标题原样返回,不被 label 顶掉', () => {
    expect(projectDraftSessionTitle('修 Orca 心跳', '未命名任务')).toBe('修 Orca 心跳');
    // 用户手动改成近似串仍是合法自定义标题(判据不做归一,见上)。
    expect(projectDraftSessionTitle('new maker', '未命名任务')).toBe('new maker');
  });

  it('没给 label 时退回原串,由调用方自己接兜底链', () => {
    // 共享层刻意不兜任何具体文案:写死中文会让 en / ja / ko 端悄悄显示中文。
    expect(projectDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE, undefined)).toBe(DEFAULT_DRAFT_SESSION_TITLE);
    expect(projectDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE, '')).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('空标题归一成空串,方便调用方直接接 `||` 兜底', () => {
    expect(projectDraftSessionTitle(null, '未命名任务')).toBe('');
    expect(projectDraftSessionTitle(undefined, '未命名任务')).toBe('');
    expect(projectDraftSessionTitle('', '未命名任务')).toBe('');
  });

  it('幂等:对投影结果再投影一次不变', () => {
    // 渲染与搜索 haystack 各自调一次,两次都必须收敛到同一个串。
    const once = projectDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE, '未命名任务');
    expect(projectDraftSessionTitle(once, '未命名任务')).toBe(once);
  });
});

describe('deriveOptimisticSessionTitle', () => {
  it('有用户文字 → 原文截断,附件名不插手', () => {
    expect(deriveOptimisticSessionTitle({
      text: '  帮我排查登录失败  ',
      fileNames: ['shot.png'],
      imageLabel: '图片',
      firstFileIsImage: true,
    })).toBe('帮我排查登录失败');
  });

  it('没文字、有附件名 → 用文件名', () => {
    expect(deriveOptimisticSessionTitle({
      text: '   ',
      fileNames: ['需求评审.pdf', 'shot.png'],
      fileLabel: '文件',
    })).toBe('需求评审.pdf');
  });

  it('附件名是绝对路径 → 只取 basename,与权威链路一致', () => {
    expect(deriveOptimisticSessionTitle({
      fileNames: ['/Users/dash/Downloads/需求评审.pdf'],
    })).toBe('需求评审.pdf');
    expect(deriveOptimisticSessionTitle({
      fileNames: ['C:\\Users\\dash\\Downloads\\shot.png'],
    })).toBe('shot.png');
  });

  it('没文字也没文件名、是图片 → 类别词', () => {
    expect(deriveOptimisticSessionTitle({
      fileNames: [],
      imageLabel: '图片',
      fileLabel: '文件',
      firstFileIsImage: true,
    })).toBe('图片');
  });

  it('什么都没有 → 空串,交给显示层兜底', () => {
    expect(deriveOptimisticSessionTitle({ text: '' })).toBe('');
    expect(deriveOptimisticSessionTitle({})).toBe('');
  });
});
