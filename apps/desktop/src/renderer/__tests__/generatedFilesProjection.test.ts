import { expect, it } from 'vitest';
import { collectCachedGeneratedFiles } from '@/components/chat/generatedFilesProjection';
import { collectGeneratedFiles } from '@/lib/generatedFiles';

it('reuses a reassembled turn after visiting another task and updates results, pagination and directory', () => {
  const user = { role: 'user', content: 'create report' };
  const tool = {
    role: 'tool_use',
    toolName: 'Write',
    toolUseId: 'write',
    toolInput: { file_path: 'report.md', content: 'report' },
  };
  const rows = [user, tool];
  const first = collectCachedGeneratedFiles(rows, '/one');
  expect(first).toMatchObject([{ path: '/one/report.md', ready: false }]);
  collectCachedGeneratedFiles([{ role: 'user', content: 'another task' }], '/one');
  expect(collectCachedGeneratedFiles([...rows], '/one')).toBe(first);
  const complete = [...rows, { role: 'tool_result', toolUseId: 'write', content: '{"ok":true}' }];
  expect(collectCachedGeneratedFiles(complete, '/one')).toEqual(
    collectGeneratedFiles(complete, '/one'),
  );
  expect(collectCachedGeneratedFiles(complete, '/one')[0].ready).toBeUndefined();
  const failed = [...rows, { role: 'tool_result', toolUseId: 'write', content: '{"ok":false}' }];
  expect(collectCachedGeneratedFiles(failed, '/one')).toEqual([]);
  expect(collectCachedGeneratedFiles(complete, '/two')).toMatchObject([{ path: '/two/report.md' }]);
  const edited = [user, { ...tool, toolInput: { file_path: 'edited.md' } }, complete[2]];
  expect(collectCachedGeneratedFiles(edited, '/two')).toMatchObject([{ path: '/two/edited.md' }]);
  expect(collectCachedGeneratedFiles([user], '/two')).toEqual([]);
});
