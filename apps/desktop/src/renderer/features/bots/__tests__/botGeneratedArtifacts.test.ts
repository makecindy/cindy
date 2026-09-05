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
  it('展示可预览的 SVG 成果，辅助预览仍然收起', () => {
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
    ]);
    expect(grouped.related.map((item) => item.name)).toEqual([
      'index.html',
      'C_full.png',
    ]);
  });

  it('只把有内容名的网页当成品，配套源码收进相关文件', () => {
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/index.html'))).toBe(false);
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/猫岛邮局-logo-方案.html'))).toBe(true);
    expect(isBotPrimaryGeneratedFile(file('/bot/workspace/logo.svg'))).toBe(true);
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

  it('不因工作目录位于系统临时目录就隐藏真正成果', () => {
    expect(partitionBotGeneratedFiles([file('/tmp/bot/report.html')], '/tmp/bot').primary).toHaveLength(1);
    expect(partitionBotGeneratedFiles([file('/tmp/bot/_preview/shot.png')], '/tmp/bot').related).toHaveLength(1);
  });

  it('结构化文档成果仍进入首层', () => {
    expect(
      isBotPrimaryGeneratedFile({
        ...file('/tmp/bot/workspace/_preview/report.unknown'),
        artifact: { format: 'pdf', title: '季度报告' },
      }),
    ).toBe(true);
  });
});
