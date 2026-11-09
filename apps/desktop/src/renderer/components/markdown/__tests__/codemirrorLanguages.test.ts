/**
 * 测试价值
 * - 生产入口与可观察结果：getCodeMirrorLanguage 为 TextLightbox 的只读 CodeMirror 编辑器提供 parser；Solidity 源码关键字、字符串和注释必须生成语法高亮样式。
 * - Bug／规则依据：Issue #9479；.sol 原先落到纯文本，CodeMirror 未进入 Solidity parser。
 * - 现有覆盖缺口：textLightbox.test.ts 只检查扩展名分发，不检查 CodeMirror parser 是否实际识别 Solidity token。
 * - 最小失败输入：pragma / contract / public、一个字符串和一个块注释；TypeScript 关键字作为原有语言回归对照。
 * - 标签兼容回归：require / revert / selfdestruct 和 NatSpec 注释；第三方自定义标签必须进入现有主题的语义角色。
 * - tier：unit；直接调用生产语言映射和 CodeMirror 语法树，不需要 DOM 或真实等待。
 * - 文件划分：首次覆盖实际语言 parser，与只检查文件类型分发的已有测试分开，避免让该轻量规则测试加载所有 parser。
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { defaultHighlightStyle, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';

import { getCodeMirrorLanguage } from '../codemirrorLanguages';

function highlightedClass(alias: string, source: string, token: string): string | null {
  const language = getCodeMirrorLanguage(alias);
  if (!language) throw new Error(`No CodeMirror language registered for ${alias}`);

  const from = source.indexOf(token);
  if (from < 0) throw new Error(`Token not found: ${token}`);
  const to = from + token.length;
  const state = EditorState.create({ doc: source, extensions: [language] });
  let classes: string | null = null;
  highlightTree(syntaxTree(state), defaultHighlightStyle, (spanFrom, spanTo, className) => {
    if (spanFrom <= from && spanTo >= to) classes = className;
  });
  return classes;
}

describe('CodeMirror language support', () => {
  it('highlights Solidity keywords, strings, and comments without changing TypeScript highlighting', () => {
    const soliditySource =
      'pragma solidity ^0.8.20; contract Vault { uint public balance; string note = "safe"; /* audited */ }';
    const typescriptSource = 'class Vault { readonly note = "safe"; /* audited */ }';

    const solidityKeyword = highlightedClass('solidity', soliditySource, 'contract');
    const solidityPublic = highlightedClass('solidity', soliditySource, 'public');
    const solidityString = highlightedClass('solidity', soliditySource, '"safe"');
    const solidityComment = highlightedClass('solidity', soliditySource, '/* audited */');

    expect(highlightedClass('solidity', soliditySource, 'pragma')).toBeTruthy();
    expect(solidityKeyword).toBeTruthy();
    expect(highlightedClass('SOL', soliditySource, 'contract')).toBe(solidityKeyword);
    expect(solidityPublic).toBe(solidityKeyword);
    expect(solidityKeyword).toBe(highlightedClass('typescript', typescriptSource, 'class'));
    expect(solidityString).toBe(highlightedClass('typescript', typescriptSource, '"safe"'));
    expect(solidityComment).toBe(highlightedClass('typescript', typescriptSource, '/* audited */'));
    expect(solidityString).not.toBe(solidityKeyword);
    expect(solidityComment).not.toBe(solidityKeyword);
    expect(highlightedClass('solidity', '/** @notice audited */\ncontract Vault {}', '@notice')).toBe(solidityComment);
  });

  it('gives Solidity-specific error handling and contract keywords standard highlight roles', () => {
    const source = 'contract Vault { function send() public { require(true); revert Failure(); selfdestruct(payable(msg.sender)); } }';
    const keyword = highlightedClass('solidity', source, 'contract');
    expect(keyword).toBeTruthy();
    expect(highlightedClass('solidity', source, 'require')).toBe(keyword);
    expect(highlightedClass('solidity', source, 'revert')).toBe(keyword);
    expect(highlightedClass('solidity', source, 'selfdestruct')).toBe(keyword);
  });
});
