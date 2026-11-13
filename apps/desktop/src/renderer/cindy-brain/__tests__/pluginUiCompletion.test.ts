import { expect, it, vi } from 'vitest';
import { collectPluginUiCompletions } from '../pluginUiCompletion';

// Unit: provider dispatch, parsed visible candidates and cancelled result.
// Existing command tests do not invoke plugin providers or bind asynchronous results.
it('does no work without providers and ignores a cancelled result', async () => {
  const call = vi.fn();
  expect(await collectPluginUiCompletions([], '@', 'query', new AbortController().signal, call)).toEqual([]);
  expect(call).not.toHaveBeenCalled();
  const entry = { instanceId: 'local__example', ghost: { manifest: { name: 'Example' } },
    contribution: { id: 'lookup', position: 'composer.completion', trigger: '@', tool: 'lookup' } };
  const controller = new AbortController();
  call.mockImplementation(async () => { controller.abort(); return { structuredContent: { items: [{ id: 'one', label: 'One', insertText: 'one' }] } }; });
  expect(await collectPluginUiCompletions([entry] as never, '@', 'o', controller.signal, call)).toEqual([]);
});

it('keeps provider candidates as plain text and filters another trigger', async () => {
  const entry = { instanceId: 'local__example', ghost: { manifest: { name: 'Example' } },
    contribution: { id: 'lookup', position: 'composer.completion', trigger: '@', tool: 'lookup' } };
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ items: [
    { id: 'one', label: 'One', insertText: '<b>plain</b>', description: 'Description' },
  ] }) }] }));
  const signal = new AbortController().signal;
  expect(await collectPluginUiCompletions([entry] as never, '/', '', signal, call)).toEqual([]);
  expect(call).not.toHaveBeenCalled();
  expect(await collectPluginUiCompletions([entry] as never, '@', 'o', signal, call)).toMatchObject([
    { id: 'one', label: 'One', insertText: '<b>plain</b>', instanceId: 'local__example', source: 'Example' },
  ]);
  expect(call).toHaveBeenCalledWith(entry, { trigger: '@', query: 'o' }, signal);
});
