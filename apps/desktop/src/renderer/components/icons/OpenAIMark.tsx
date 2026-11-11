/**
 * OpenAIMark —— OpenAI 官方六瓣花结,单色 currentColor。
 * 模型厂牌 mark,与 Agent 身份的 ClaudeMark/CodexMark 区分
 * (2026-07-21 产品语义纠偏)。
 */

import { OPENAI_MARK_PATH } from '../../../shared/brandMarkPaths';

interface OpenAIMarkProps {
  size?: number;
  className?: string;
}

export function OpenAIMark({ size = 14, className }: OpenAIMarkProps) {
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
        d={OPENAI_MARK_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
