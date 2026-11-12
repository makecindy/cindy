/**
 * AnthropicMark —— Anthropic 官方 "AA" wordmark,单色 currentColor。
 * 模型厂牌 mark,与 Agent 身份的 ClaudeMark/CodexMark 区分
 * (2026-07-21 产品语义纠偏)。
 */

import { ANTHROPIC_MARK_PATH } from '../../../shared/brandMarkPaths';

interface AnthropicMarkProps {
  size?: number;
  className?: string;
}

export function AnthropicMark({ size = 14, className }: AnthropicMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d={ANTHROPIC_MARK_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
