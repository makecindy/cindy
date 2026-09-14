// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { isPlanModeComposerCommandText } from '../components/new-chat/planModeComposerCommand';
import {
  beginSlashCommandRosterLoad,
  EMPTY_SLASH_COMMANDS,
  isSlashCommandRosterReady,
  type SlashCommandRosterState,
  type UnifiedCommand,
} from '../lib/slashCommands';

const help: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Open help' };

/**
 * 回归 guard：ChatInput 里 dispatchSend 通过
 * `slashCommandsReady ? mergedCommands : null` 决定 /plan 是否按计划模式命令处理。
 * 一旦 dispatchSend 的依赖数组漏掉 slashCommandsReady / mergedCommands，roster
 * 延迟加载完成后闭包仍持旧值（false / null），用户敲 /plan 回车会退化成普通消息。
 *
 * 这里把「roster 就绪 → commands 可用」这条映射与生产实现对齐，确保延迟加载完成
 * 后 /plan 仍被识别为计划模式命令，而不是被当作普通文本发送。
 */
describe('/plan under delayed slash-roster load', () => {
  it('does not treat /plan as plan-mode while the roster is still loading', () => {
    const loading = beginSlashCommandRosterLoad(
      { contextKey: '', status: 'ready', commands: EMPTY_SLASH_COMMANDS },
      'ctx',
    );
    const ready = isSlashCommandRosterReady(loading, 'ctx');
    const commands: UnifiedCommand[] | null = ready ? loading.commands : null;

    expect(ready).toBe(false);
    expect(isPlanModeComposerCommandText('/plan', true, commands)).toBe(false);
  });

  it('recognizes /plan once the delayed roster becomes ready', () => {
    const readyState: SlashCommandRosterState = {
      contextKey: 'ctx',
      status: 'ready',
      commands: [help],
    };
    const ready = isSlashCommandRosterReady(readyState, 'ctx');
    const commands: UnifiedCommand[] | null = ready ? readyState.commands : null;

    expect(ready).toBe(true);
    expect(isPlanModeComposerCommandText('/plan', true, commands)).toBe(true);
  });
});
