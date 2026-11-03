import {
  FILE_VISUAL_LABELS,
  getFileVisualKind,
  type FileVisualInput,
  type FileVisualKind,
} from '@cindy/maker-shared';

// Existing file-badge identity colors; new categories remain neutral.
const KIND_ACCENT: Record<FileVisualKind, string | null> = {
  pdf: 'var(--file-badge-pdf)',
  document: 'var(--file-badge-doc)',
  sheet: 'var(--file-badge-sheet)',
  slide: 'var(--file-badge-slide)',
  code: 'var(--file-badge-code)',
  text: null,
  image: null,
  audio: null,
  video: null,
  archive: null,
  database: null,
  file: null,
};

/**
 * 自绘文件图标:一张带折角的纸,右下角压一枚类型色角标。
 * 纸面 / 描边走 token,只有角标带类型色。
 */
export function FileTypeTile({ name, mimeType }: FileVisualInput) {
  const kind = getFileVisualKind({ name, mimeType });
  const accent = KIND_ACCENT[kind];
  const label = FILE_VISUAL_LABELS[kind];
  // viewBox 32 渲染成 32px(1:1),角标文字 10 个单位即屏幕 10px —— DESIGN.md §3
  // 的下限(Micro Label 10–13px)。此前 26px 渲染 + 7.5 单位只有约 6px,越界了。
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden focusable="false">
      {/* 纸张本体 + 折角 */}
      <path
        d="M6.5 2.5h11.2L25.5 10.3V27a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 27V4a1.5 1.5 0 0 1 1.5-1.5Z"
        fill="var(--surface-elevated)"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 2.6V9a1.5 1.5 0 0 0 1.5 1.5h6.2"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* 正文示意线:没有角标的中性类型靠它表达「这是文档」 */}
      <path
        d="M9 14h13M9 17.5h13M9 21h7.5"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity={accent ? 0.35 : 0.9}
      />
      {/* 类型角标:容纳 10px 标签,所以铺到底边整条 */}
      {label ? (
        <>
          <rect
            x="3"
            y="18.5"
            width="26"
            height="13.5"
            rx="3"
            fill={accent ?? 'var(--surface-chip)'}
          />
          {/* 字重 500 封顶:DESIGN.md §3「Weight restraint — 只有 400 与 500,No bold」。 */}
          <text
            x="16"
            y="28.6"
            textAnchor="middle"
            fontSize="10"
            fontWeight="500"
            letterSpacing="0.3"
            fill={accent ? 'var(--file-badge-fg)' : 'var(--text-primary)'}
          >
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}
