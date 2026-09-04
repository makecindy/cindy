import { describe, expect, it } from 'vitest';

import type { GeneratedFileRef } from '@/lib/generatedFiles';
import {
  generatedFileExtension,
  isBotPrimaryGeneratedFile,
  isBotSupportingGeneratedFile,
  partitionBotGeneratedFiles,
} from '../botGeneratedArtifacts';

const file = (path: string): GeneratedFileRef => ({
  path,
  name: path.replace(/\\/g, '/').split('/').at(-1) ?? path,
  source: 'tool',
});

describe('伙伴产物分组', () => {
  it('把 Kiro 的 SVG 与 HTML 提到成果层，把预览截图留在相关文件', () => {
    const files = [
      file('/bot/workspace/logo-concept-A-邮筒猫徽章.svg'),
      file('/bot/workspace/logo-concept-B-猫尾小岛横版.svg'),
      file('/bot/workspace/logo-concept-C-纪念邮票版.svg'),
      file('/bot/workspace/index.html'),
      file('/bot/workspace/_preview/C_full.png'),
    ];

    const grouped = partitionBotGeneratedFiles(files);

    expect(grouped.primary.map((item) => item.name)).toEqual([
      'logo-concept-A-邮筒猫徽章.svg',
      'logo-concept-B-猫尾小岛横版.svg',
      'logo-concept-C-纪念邮票版.svg',
      'index.html',
    ]);
    expect(grouped.related.map((item) => item.name)).toEqual(['C_full.png']);
  });

  it('把网页配套源码放进相关文件，不把它们冒充成果', () => {
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/index.html'))).toBe(true);
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/styles.css'))).toBe(false);
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/app.js'))).toBe(false);
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/data.json'))).toBe(false);
  });

  it('兼容 Windows 路径并优先识别辅助目录', () => {
    const screenshot = file('C:\\bot\\workspace\\_PREVIEW\\shot.SVG');
    expect(generatedFileExtension(screenshot)).toBe('svg');
    expect(isBotSupportingGeneratedFile(screenshot)).toBe(true);
    expect(isBotPrimaryGeneratedFile(screenshot)).toBe(false);
  });

  it('结构化文档成果仍进入首层', () => {
    expect(
      isBotPrimaryGeneratedFile({
        ...file('/bot/workspace/report.unknown'),
        artifact: { format: 'pdf', title: '季度报告' },
      }),
    ).toBe(true);
  });
});
