import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(APP_ROOT, relPath), 'utf8');
}

describe('mobile localized presentation refresh', () => {
  it('renders the automation form title once', () => {
    const source = read('app/automations/[deviceId].tsx');
    const formHeader = source.slice(
      source.indexOf('<View style={styles.formHeader}>'),
      source.indexOf('{error ? <Text style={styles.formError}>'),
    );

    expect(formHeader.match(/devices\.automations\.form\.title\.edit/g)).toHaveLength(1);
    expect(formHeader.match(/devices\.automations\.form\.title\.create/g)).toHaveLength(1);
  });

  it('rebuilds the cached composer presentation when the language changes', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const composerProjection = source.slice(
      source.indexOf('const composerLayout = useMemo'),
      source.indexOf('const compactComposer ='),
    );

    expect(composerProjection).toContain('i18nInstance.language');
  });

  it('rebuilds localized session history and tail errors when the language changes', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const renderItems = source.slice(
      source.indexOf('const renderItems = useMemo'),
      source.indexOf('// 只在本次 render 真正 commit 后更新 reconcile 基准'),
    );
    const tailBanner = source.slice(
      source.indexOf('const tailBannerState = useMemo'),
      source.indexOf('// 主按钮(重试 / 继续任务)'),
    );

    expect(renderItems).toContain('i18nInstance.language');
    expect(tailBanner).toContain('i18nInstance.language');
  });

  it('rebuilds open interaction cards when the language changes', () => {
    const source = read('src/session/InteractionPanel.tsx');

    expect(source).toContain('[i18nInstance.language, item.request]');
    expect(source).toContain('[currentIndex, i18nInstance.language, questions]');
    expect(source).toContain('[filePath, i18nInstance.language, originalPlan, planText]');
  });

  it('rebuilds cached payload presentations when the language changes', () => {
    const source = read('src/session/MessageRenderer.tsx');

    expect(source.match(/\[i18nInstance\.language, payload\]/g)).toHaveLength(4);
    expect(source).toContain('[diff, i18nInstance.language]');
  });

  it('localizes stored file-preview failures when they are rendered', () => {
    const source = read('src/session/MessageRenderer.tsx');

    expect(source).toContain('message: describeTextPreviewFailure(previewLoadState.result)');
    expect(source).toContain('[i18nInstance.language, previewLoadState]');
  });

  it('rebuilds bulk-action copy when the language changes', () => {
    const source = read('app/devices/[deviceId].tsx');

    expect(source).toContain('[i18nInstance.language, selectedSessions]');
  });

  it('rebuilds remote and collaboration notices when the language changes', () => {
    const source = read('app/sessions/[sessionId].tsx');

    expect(source).toContain('[connectionError, i18nInstance.language]');
    expect(source.match(/\[currentSession\?\.orcaRole, i18nInstance\.language\]/g)).toHaveLength(2);
  });

  it('keeps new-task authentication errors raw until render time', () => {
    const source = read('app/sessions/new.tsx');

    expect(source).toContain('setError(raw)');
    expect(source).toContain('{describeAgentAuthError(error) ?? error}');
  });

  it('keeps schedule validation metadata until render time', () => {
    const source = read('app/automations/[deviceId].tsx');

    expect(source).toContain('setFormError(validation)');
    expect(source).toContain('localizeScheduleDraftValidation(formError, mobilePresentationLocalizer)');
    expect(source).toContain('error={formErrorText}');
  });

  it('keeps template-parameter validation metadata until render time', () => {
    const source = read('app/automations/[deviceId].tsx');

    expect(source).toContain('setFormError(paramError)');
    expect(source).toContain('selectedTemplatePresentation,');
    expect(source).toContain('localizeTemplateParamValidation(');
  });

  it('rebuilds localized session sections when the language changes', () => {
    const source = read('app/devices/[deviceId].tsx');
    const sectionProjection = source.slice(
      source.indexOf('const sections = useMemo'),
      source.indexOf('const listContext = useMemo'),
    );

    expect(sectionProjection).toContain('i18nInstance.language');
  });

  it('rebuilds file metadata when the language changes', () => {
    const source = read('app/files/[sessionId].tsx');

    expect(source).toContain('[i18nInstance.language, sortMode]');
  });

  it('rebuilds preview-page file metadata when the language changes', () => {
    const source = read('app/files/preview/[sessionId].tsx');
    const directoryRequest = source.slice(
      source.indexOf('// 同目录 pager 远端数据:'),
      source.indexOf('// 同目录 pager 展示投影:'),
    );
    const siblingProjection = source.slice(
      source.indexOf('// 同目录 pager 展示投影:'),
      source.indexOf('const current = siblings?.[pageIndex] ?? null'),
    );

    expect(directoryRequest).not.toContain('i18nInstance.language');
    expect(siblingProjection).toContain('i18nInstance.language');
  });

  it('rebuilds quota summaries when the language changes', () => {
    const source = read('src/session/SessionMenuSheet.tsx');

    expect(source).toContain(
      '[accountUsage, i18nInstance.language, quotaBucketTables, session.model, visible, quotaStaleTick]',
    );
    expect(source).toContain('[codexRateLimits, i18nInstance.language]');
  });

  it('rebuilds pending-send presentations when the language changes', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const pendingSendProjection = source.slice(
      source.indexOf('const pendingSendItems = useMemo'),
      source.indexOf('const messageListItems = useMemo'),
    );

    expect(pendingSendProjection).toContain('i18nInstance.language');
  });
});
