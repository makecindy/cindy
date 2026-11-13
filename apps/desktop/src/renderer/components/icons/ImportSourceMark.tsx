/**
 * ImportSourceMark —— 任务导入来源（其他 AI 编程工具）的单色身份图形。
 * 路径与显示名共用 @cindy/maker-shared/import-source-marks；全部 currentColor，跟随主题与父级染色。
 */

import { IMPORT_SOURCE_MARKS, IMPORT_SOURCE_NAMES } from '@cindy/maker-shared/import-source-marks';
import { PROVIDER_LOGO_PATHS } from '@cindy/model-providers/branding';

import type { ImportSourceId } from '../../../shared/sessionImport';
import { ClaudeMark } from './ClaudeMark';
import { CodexMark } from './CodexMark';
import { PiMark } from './PiMark';

export { IMPORT_SOURCE_NAMES };

interface Props {
  source: ImportSourceId;
  size?: number;
  className?: string;
}

export function ImportSourceMark({ source, size = 16, className }: Props) {
  if (source === 'claude') return <ClaudeMark size={size} className={className} />;
  if (source === 'codex') return <CodexMark size={size} className={className} />;
  if (source === 'pi') return <PiMark size={size} className={className} />;
  const mark = source === 'opencode' || source === 'deepseek'
    ? { viewBox: '0 0 24 24', paths: [PROVIDER_LOGO_PATHS[source]] }
    : IMPORT_SOURCE_MARKS[source];
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <g fill="currentColor" fillRule="evenodd" clipRule="evenodd">
        {mark.paths.map((d, i) => <path key={i} d={d} />)}
      </g>
    </svg>
  );
}
