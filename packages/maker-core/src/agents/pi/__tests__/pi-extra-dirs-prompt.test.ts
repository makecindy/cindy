/**
 * #8812:Pi 的附加目录说明必须把完整路径交给模型 —— 用户显式添加的只读引用与
 * 可读写目录恢复列出完整路径(hosted 任务为供应商端虚拟路径)。插件 Library 根
 * 不进通用目录清单,其授权映射由每轮 <cindy-library-native-read> 单独下发,
 * 维持 #3745 起不把 Library 绝对路径写进本段的约定。
 *
 * 这里的 dir 字符串对 prompt 是 opaque 文本(远程会话可以是供应商端虚拟路径),
 * 不是宿主文件系统路径,断言按逐字透传写固定值。
 */
import { describe, expect, it } from 'vitest';

import { piExtraDirsPrompt } from '../index.js';

describe('piExtraDirsPrompt (#8812)', () => {
  it('把用户只读目录与可读写目录的完整路径列入对应段', () => {
    const prompt = piExtraDirsPrompt(['/refs/docs'], ['/out'], null);
    expect(prompt).toContain('<cindy-extra-reference-directories>');
    expect(prompt).toContain('- /refs/docs');
    expect(prompt).toContain('<cindy-extra-writable-directories>');
    expect(prompt).toContain('- /out');
  });

  it('Library 根不进通用目录清单,但保留 library 相对键契约说明', () => {
    const root = '/owner/libraries/ghost-1';
    const prompt = piExtraDirsPrompt(['/refs/docs', root], [], root);
    expect(prompt).toContain('- /refs/docs');
    expect(prompt).not.toContain(`- ${root}`);
    expect(prompt).toContain('library:assets/<2>/<hash>/blob.<ext>');
  });

  it('唯一只读目录就是 Library 根时仍渲染契约段', () => {
    const root = '/owner/libraries/ghost-1';
    const prompt = piExtraDirsPrompt([root], [], root);
    expect(prompt).toContain('<cindy-extra-reference-directories>');
    expect(prompt).not.toContain(`- ${root}`);
    expect(prompt).toContain('Do not modify them');
  });

  it('无目录时返回空串(不进入 system 段或用户轮前缀)', () => {
    expect(piExtraDirsPrompt([], [], undefined)).toBe('');
    expect(piExtraDirsPrompt([], ['/out'], null)).not.toContain('<cindy-extra-reference-directories>');
  });
});
