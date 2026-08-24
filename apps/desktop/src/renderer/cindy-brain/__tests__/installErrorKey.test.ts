import { describe, expect, it } from 'vitest';

import { GHOST_OFFICIAL_ID_PREFIXES } from '../../../shared/ghost';
import i18n from '../../i18n';
import { ghostInstallErrorKey } from '../installErrorKey';

describe('ghostInstallErrorKey', () => {
  it('distinguishes a valid plugin that needs a newer Host from an invalid package', () => {
    expect(ghostInstallErrorKey('GHOST_HOST_UNSUPPORTED')).toBe(
      'settings.ghosts.errors.hostUnsupported',
    );
    expect(ghostInstallErrorKey('GHOST_FILE_INVALID')).toBe('settings.ghosts.errors.fileInvalid');
  });

  it('maps Broker authorization failures without changing generic invalid-file copy', () => {
    expect(ghostInstallErrorKey('GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED')).toBe(
      'settings.ghosts.errors.brokerManualInstallNotAuthorized',
    );
    expect(ghostInstallErrorKey('GHOST_BROKER_NOT_AUTHORIZED')).toBe(
      'settings.ghosts.errors.brokerNotAuthorized',
    );
    expect(ghostInstallErrorKey('GHOST_BROKER_REDIRECT_PORT_REQUIRED')).toBe(
      'settings.ghosts.errors.brokerRedirectPortRequired',
    );
    // This control kills a broad remap that turns every malformed .cindy error
    // into the Broker guidance.
    expect(ghostInstallErrorKey('GHOST_FILE_INVALID')).toBe('settings.ghosts.errors.fileInvalid');
  });

  it.each(['zh-CN', 'en', 'ja', 'ko', 'zh-TW'])(
    'keeps both Broker authorization reasons actionable in %s',
    (locale) => {
      for (const code of [
        'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
        'GHOST_BROKER_NOT_AUTHORIZED',
      ]) {
        const message = i18n.getFixedT(locale)(ghostInstallErrorKey(code)).toString();
        expect(message).toContain('ghost_forge_pack');
        expect(message).not.toBe(i18n.getFixedT(locale)('settings.ghosts.errors.fileInvalid'));
      }
    },
  );

  it.each(['zh-CN', 'en', 'ja', 'ko', 'zh-TW'])(
    'keeps the missing redirectPort admission error distinct and actionable in %s',
    (locale) => {
      const message = i18n
        .getFixedT(locale)(ghostInstallErrorKey('GHOST_BROKER_REDIRECT_PORT_REQUIRED'))
        .toString();
      expect(message).toContain('redirectPort');
      expect(message).not.toBe(i18n.getFixedT(locale)('settings.ghosts.errors.fileInvalid'));
    },
  );

  it.each(['zh-CN', 'en', 'ja', 'ko', 'zh-TW'])(
    'renders the complete reserved-prefix authority in the %s install error',
    (locale) => {
      const key = ghostInstallErrorKey('GHOST_ID_RESERVED');
      const rawMessage = i18n.getResource(locale, 'common', key);
      const message = i18n.getFixedT(locale)(key).toString();

      // 原始资源存在排除缺 key 后静默回退英文；占位符排除硬写完整前缀表。
      expect(rawMessage).toEqual(expect.any(String));
      expect(rawMessage).toContain('{{reservedGhostIdPrefixes}}');
      // 渲染结果排除默认变量漏接或插值失效。
      expect(message).toContain(GHOST_OFFICIAL_ID_PREFIXES.join(' / '));
      expect(message).not.toContain('{{reservedGhostIdPrefixes}}');
    },
  );

  it.each(['zh-CN', 'en', 'ja', 'ko', 'zh-TW'])(
    'renders the complete reserved-prefix authority in the %s marketplace guide',
    (locale) => {
      const key = 'settings.ghosts.market.sources.guide.rulesBody';
      const rawMessage = i18n.getResource(locale, 'common', key);
      const message = i18n.getFixedT(locale)(key).toString();

      // 原始资源存在排除缺 key 后静默回退英文；占位符排除硬写完整前缀表。
      expect(rawMessage).toEqual(expect.any(String));
      expect(rawMessage).toContain('{{reservedGhostIdPrefixes}}');
      // 渲染结果排除默认变量漏接或插值失效。
      expect(message).toContain(GHOST_OFFICIAL_ID_PREFIXES.join(' / '));
      expect(message).not.toContain('{{reservedGhostIdPrefixes}}');
    },
  );

  it.each([
    { locale: 'zh-CN', fragments: ['拖入', '选择文件', 'ghost_forge_pack', '自定义插件市场'] },
    {
      locale: 'en',
      fragments: [
        'dragging in a package',
        'choosing a file',
        'ghost_forge_pack',
        'custom plugin marketplace',
      ],
    },
    {
      locale: 'ja',
      fragments: ['ドラッグ', 'ファイル選択', 'ghost_forge_pack', 'カスタムプラグインマーケット'],
    },
    {
      locale: 'ko',
      fragments: ['끌어다 놓기', '파일 선택', 'ghost_forge_pack', '사용자 지정 플러그인 마켓'],
    },
    {
      locale: 'zh-TW',
      fragments: ['拖入', '選取檔案', 'ghost_forge_pack', '自訂插件市場'],
    },
  ])('keeps all four user install channels in the $locale marketplace guide', ({ locale, fragments }) => {
    const rawMessage = i18n.getResource(
      locale,
      'common',
      'settings.ghosts.market.sources.guide.rulesBody',
    );

    // 只钉四个必要语义点，排除说明被重新写窄成仅禁止某一个装入来源。
    expect(rawMessage).toEqual(expect.any(String));
    for (const fragment of fragments) expect(rawMessage).toContain(fragment);
  });

  it.each([
    {
      locale: 'zh-CN',
      fragment: 'id 使用官方保留前缀（{{reservedGhostIdPrefixes}}）',
    },
    {
      locale: 'zh-TW',
      fragment: 'id 使用官方保留字首（{{reservedGhostIdPrefixes}}）',
    },
  ])('puts the reserved-prefix category before its id list in $locale', ({ locale, fragment }) => {
    const rawMessage = i18n.getResource(
      locale,
      'common',
      'settings.ghosts.market.sources.guide.rulesBody',
    );

    // This excludes the ambiguous Chinese order that placed the list before
    // “official reserved prefix” and omitted that the prefix belongs to id.
    expect(rawMessage).toContain(fragment);
  });
});
