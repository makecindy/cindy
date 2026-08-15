import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { i18n } from '@/i18n';
import { marketActionErrorKey, marketActionErrorMessage } from '../marketErrors';

const here = dirname(fileURLToPath(import.meta.url));
const skillhubDir = resolve(here, '../..');
const routerSource = readFileSync(resolve(skillhubDir, '../../router.tsx'), 'utf8');
const localDetailSource = readFileSync(resolve(skillhubDir, 'SkillhubDetailView.tsx'), 'utf8');

describe('market route scope', () => {
  it('has no fullscreen market detail or manage routes (detail and management live in the preview panel)', () => {
    expect(routerSource).not.toContain('SkillhubMarketDetailView');
    expect(routerSource).not.toContain('SkillhubMarketManageView');
  });

  it('keeps cloud market management out of the local skill detail page', () => {
    expect(localDetailSource).not.toContain('市场管理');
    expect(localDetailSource).not.toContain('skillhub:update-published');
    expect(localDetailSource).not.toContain('updatePublished');
    expect(localDetailSource).not.toContain('deletePublished');
    expect(localDetailSource).not.toContain('marketManagePath');
  });

  it('keeps Clone wording for acquisition actions', () => {
    const marketCardSource = readFileSync(resolve(skillhubDir, 'components/MarketCard.tsx'), 'utf8');
    expect(marketCardSource).toContain('Clone');
    expect(marketCardSource).not.toContain('安装到本机');
  });

  it('keeps team transfer disabled while the product plan is being revised', () => {
    const acceptanceSource = readFileSync(resolve(here, 'marketManagementAcceptanceCases.md'), 'utf8');

    expect(acceptanceSource).not.toContain('移到团队库');
    expect(acceptanceSource).not.toContain('转到团队库');
  });

  it('opens the half-screen cloud preview when a market card is clicked', () => {
    const listSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketListView.tsx'), 'utf8');
    const previewSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketPreviewPanel.tsx'), 'utf8');

    expect(listSource).toContain('SkillhubMarketPreviewPanel');
    expect(listSource).toContain('nextMarketPreviewName');
    expect(listSource).toContain('setMarketSelected(newName ? skill : null);');
    expect(previewSource).toContain('getPublishedFiles');
    expect(previewSource).toContain('readPublishedFile');
    expect(previewSource).toContain('allowPrivilegedLinks={false}');
    expect(previewSource).toContain('ManageMenu');
    expect(listSource).toContain('onManageAction={handleManageAction}');
    expect(previewSource).not.toContain('previewMarket');
  });

  it('gates cloud management to the My Published entry point', () => {
    const listSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketListView.tsx'), 'utf8');
    const viewModelSource = readFileSync(resolve(skillhubDir, 'lib/marketDetailViewModel.ts'), 'utf8');

    expect(listSource).toContain('marketCardPrimaryAction');
    expect(viewModelSource).toContain("input.listVisibility === 'mine'");
  });
});

describe('market management copy and errors', () => {
  it('documents ownership, listing, and delete impact in second-confirm copy', () => {
    const zhLocale = readFileSync(
      resolve(skillhubDir, '../../i18n/locales/zh-CN/common.json'),
      'utf8',
    );

    expect(zhLocale).toContain('下架后变为私有');
    expect(zhLocale).toContain('已安装的用户不受影响');
    expect(zhLocale).toContain('也不会删除你本机的 Skill 文件');
  });

  it('consolidates ownership transfer into the manage-visibility dialog', () => {
    const editorSource = readFileSync(resolve(skillhubDir, 'components/VisibilityEditorDialog.tsx'), 'utf8');

    expect(editorSource).toContain('skillhub.visibilityEditor.tierLabel');
    expect(editorSource).toContain('PublisherPicker');
    expect(editorSource).toContain("teamSlug = null");
  });

  it('does not expose an extra published status pill in the market preview panel', () => {
    const previewSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketPreviewPanel.tsx'), 'utf8');

    expect(previewSource).not.toContain('已发布');
  });

  it('exposes shared visibility with visibleSlugs through desktop IPC', () => {
    const preloadSource = readFileSync(resolve(skillhubDir, '../../../preload/preload.ts'), 'utf8');
    const viteEnvSource = readFileSync(resolve(skillhubDir, '../../vite-env.d.ts'), 'utf8');

    expect(preloadSource).toContain("visibility: 'private' | 'shared' | 'public';");
    expect(preloadSource).toContain('getPublishedVisibility');
    expect(preloadSource).toContain('teamSlug?: string');
    expect(viteEnvSource).toContain("visibility: 'private' | 'shared' | 'public';");
    expect(viteEnvSource).toContain('getPublishedVisibility');
    expect(viteEnvSource).toContain('teamSlug?: string');
  });

  it('lets the market manage dropdown close before opening dialogs', () => {
    const cardSource = readFileSync(resolve(skillhubDir, 'components/MarketCard.tsx'), 'utf8');

    expect(cardSource).not.toContain('event.preventDefault();');
  });

  it('keeps the market preview panel out of the window drag region', () => {
    const listSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketListView.tsx'), 'utf8');
    const previewSource = readFileSync(resolve(skillhubDir, 'SkillhubMarketPreviewPanel.tsx'), 'utf8');

    expect(previewSource).toContain('WINDOW_NO_DRAG_STYLE');
    expect(previewSource).toContain("...WINDOW_NO_DRAG_STYLE");
    expect(listSource).toContain('previewSkill ? WINDOW_NO_DRAG_STYLE : WINDOW_DRAG_STYLE');
  });

  it('updates only the Hub summary from the market info editor', () => {
    const editorSource = readFileSync(resolve(skillhubDir, 'components/MarketInfoEditDialog.tsx'), 'utf8');
    const fieldsStart = editorSource.indexOf('fields: {');
    const fieldsEnd = editorSource.indexOf('},', fieldsStart);
    const fieldsSource = editorSource.slice(fieldsStart, fieldsEnd);

    expect(fieldsSource).toContain('summary: description');
    expect(fieldsSource).not.toMatch(/\n\s+description[,}]/);
  });

  it('keeps the confirm provider in the main App tree so AuthProvider has a stable context during HMR', () => {
    const indexSource = readFileSync(resolve(skillhubDir, '../../main-entry.tsx'), 'utf8');
    const appSource = readFileSync(resolve(skillhubDir, '../../App.tsx'), 'utf8');

    expect(indexSource).toContain('<App />');
    expect(appSource).toContain('ConfirmDialogProvider');
    expect(appSource.indexOf('<ConfirmDialogProvider>')).toBeLessThan(appSource.indexOf('<AuthProvider>'));
  });

  it('hides raw missing Hub management endpoint errors from users', () => {
    expect(marketActionErrorKey(
      'skill hub PATCH /api/s2s/v1/skills/lark-calendar returned 404',
      'HUB_404',
    )).toBe('skillhub.marketErrors.managementApiUnavailable');
    expect(marketActionErrorMessage(
      'skill hub PATCH /api/s2s/v1/skills/lark-calendar returned 404',
      'HUB_404',
      i18n.t,
    )).toBe('Hub management API is not ready. Please try again later');
  });

  it('does not hide real authorization failures behind missing endpoint copy', () => {
    expect(marketActionErrorKey(
      'skill hub POST /api/s2s/v1/skills/lark-calendar/set-visibility returned 403: forbidden',
      'HUB_403',
    )).toBe('skillhub.marketErrors.forbidden');
    expect(marketActionErrorMessage(
      'skill hub POST /api/s2s/v1/skills/lark-calendar/set-visibility returned 403: forbidden',
      'HUB_403',
      i18n.t,
    )).toBe('No permission to operate on this Skill');
  });
});
