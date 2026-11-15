/**
 * Regression coverage for signed Plugin icon failure and recovery.
 * @vitest-environment jsdom
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GhostPluginIcon } from '../GhostPluginIcon';
import { LEGACY_SCAFFOLD_ICON_DATA_URL } from './fixtures/legacyScaffoldIcon';

describe('GhostPluginIcon', () => {
  // 旧脚手架 PNG 曾被当作有效图标；签名 URL 失败用例不覆盖此输入。Tier: unit。
  it('uses a functional symbol for the historical scaffold PNG and accepts an author replacement', () => {
    const onIconLoadError = vi.fn();
    const { container, rerender } = render(
      <GhostPluginIcon
        iconDataUrl={LEGACY_SCAFFOLD_ICON_DATA_URL}
        iconId="torch-announcements"
        iconName="火炬公告审核"
        onIconLoadError={onIconLoadError}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(onIconLoadError).not.toHaveBeenCalled();

    // A different solid PNG is still an author asset, not the known historical placeholder.
    const replacement =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwcHD4DwADRAHA6ce2AgAAAABJRU5ErkJggg==';
    rerender(
      <GhostPluginIcon
        iconDataUrl={replacement}
        iconId="torch-announcements"
        iconName="火炬公告审核"
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(replacement);
  });

  it('requests metadata renewal after a signed URL fails and accepts the replacement URL', () => {
    const onIconLoadError = vi.fn();
    const { container, rerender } = render(
      <GhostPluginIcon
        iconDataUrl="https://oss.example/old-icon?signature=old"
        iconId="cindy-github"
        iconName="Cindy GitHub"
        onIconLoadError={onIconLoadError}
      />,
    );

    fireEvent.error(container.querySelector('img')!);
    expect(onIconLoadError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();

    rerender(
      <GhostPluginIcon
        iconDataUrl="https://oss.example/new-icon?signature=new"
        iconId="cindy-github"
        iconName="Cindy GitHub"
        onIconLoadError={onIconLoadError}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://oss.example/new-icon?signature=new',
    );
  });
});
