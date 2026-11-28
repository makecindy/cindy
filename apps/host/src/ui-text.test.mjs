/**
 * The Host's background copy in the locale (ui-text.ts bindHostUiText).
 * - Rule: main-process copy that reaches the user from background services follows the locale, as
 *   bootstrap-electron.ts binds configureUiText; a key the catalog lacks keeps the English fallback
 *   (release table 甲 23).
 * - Gap: the Host bound nothing, so the database startup failure, the one line a user most needs to
 *   read, was always the English fallback.
 * - Minimal failing input: a Chinese system language and the schema lease failure title.
 * - Tier: unit, through the reader the database startup failure uses (localDb/hostUiText.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDbText } from '../../desktop/src/main/localDb/hostUiText.ts';
import { configureUiText } from '../../desktop/src/main/uiText.ts';
import { bindHostUiText } from './ui-text.ts';

test('the database startup failure follows the system language once the Host binds its copy', t => {
  t.after(() => configureUiText((_key, fallback) => fallback));
  assert.equal(localDbText('localDbFatal.schemaLease.title'), 'Local database is in use', 'unbound: the English fallback');
  bindHostUiText(() => ['zh-CN']);
  assert.equal(localDbText('localDbFatal.schemaLease.title'), '本地数据暂时无法打开');
});
