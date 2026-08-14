import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shouldHandlePublishProgressEvent } from '../publishProgressFilter';

describe('publish progress event filter', () => {
  it('ignores background scan events when the dialog has no active publish', () => {
    expect(shouldHandlePublishProgressEvent({ name: 'lark-task' }, null)).toBe(false);
    expect(shouldHandlePublishProgressEvent({}, null)).toBe(false);
  });

  it('accepts active publish phases and rejects events for other skills', () => {
    expect(shouldHandlePublishProgressEvent({}, 'lark-task')).toBe(true);
    expect(shouldHandlePublishProgressEvent({ name: 'lark-task' }, 'lark-task')).toBe(true);
    expect(shouldHandlePublishProgressEvent({ name: 'other-skill' }, 'lark-task')).toBe(false);
  });

  it('clears the active publish name when closing during background scanning', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Windows checkout(core.autocrlf)下源码是 CRLF;归一成 LF 后含 \n 的正则/片段断言才跨平台成立。
    const source = readFileSync(resolve(here, '../../PublishDialog.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const scanningCloseBranch = source.match(/if \(pubState\.phase === 'scanning'\) \{[\s\S]*?return;\n {4}\}/)?.[0] ?? '';

    expect(scanningCloseBranch).toContain('activePublishNameRef.current = null;');
    expect(scanningCloseBranch).toContain("dispatch({ type: 'CLOSE' });");
    expect(scanningCloseBranch).not.toContain('stopScanPoll');
  });

  it('preserves the lexical discovery path for rename safety checks', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../PublishDialog.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');

    expect(source).toContain('absolutePath: skill.discoveredPath ?? eff.absolutePath');
  });
});
