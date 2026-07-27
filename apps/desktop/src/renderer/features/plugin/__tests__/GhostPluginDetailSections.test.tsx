/**
 * Regression coverage for Plugin detail section content and interaction behavior.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'settings.ghosts.detail.openTool': `Open ${String(options?.name ?? '')}`,
        'settings.ghosts.detail.toolsTitle': 'Tools',
        'settings.ghosts.detail.viewAllTools': 'See All',
        'settings.ghosts.detail.collapseTools': 'Show Less',
        'settings.ghosts.detail.noToolDescription': 'No description',
        'settings.ghosts.detail.permissionsTitle': 'Permissions',
        'settings.ghosts.detail.viewAllPermissions': 'See All',
        'settings.ghosts.detail.permissionsDialogDescription': `${String(options?.count ?? '')} permissions`,
        'settings.ghosts.detail.closeDialog': 'Close dialog',
        'settings.ghosts.perm.networkHost': `Access ${String(options?.host ?? '')}`,
        'settings.ghosts.perm.networkHostDetail': 'Can access this declared domain.',
        'settings.ghosts.perm.command': `Command ${String(options?.command ?? '')}`,
        'settings.ghosts.perm.tool': `Tool ${String(options?.name ?? '')}`,
        'settings.ghosts.perm.cindyImageGenerate': 'Generate images',
        'settings.ghosts.detail.infoTitle': 'Details',
        'settings.ghosts.detail.byAuthor': `By ${String(options?.author ?? '')}`,
        'settings.ghosts.detail.infoVersion': 'Version',
        'settings.ghosts.detail.infoAuthor': 'Author',
        'settings.ghosts.detail.infoId': 'Identifier',
        'settings.ghosts.detail.infoContents': 'Contents',
        'settings.ghosts.contents.code': 'Executable Code',
        'settings.ghosts.detail.infoPanel': 'Panel',
        'settings.ghosts.detail.infoLocation': 'Install Location',
        'settings.ghosts.detail.copyLocation': 'Copy Install Location',
        'settings.ghosts.detail.locationCopied': 'Install location copied',
        'settings.ghosts.detail.locationCopyFailed': 'Could not copy install location',
        'settings.ghosts.detail.openLocation': 'Open Install Location',
        'settings.ghosts.detail.expandInfoValue': `Show full ${String(options?.label ?? '')}`,
        'settings.ghosts.detail.collapseInfoValue': `Collapse ${String(options?.label ?? '')}`,
        'settings.ghosts.detail.panelNotDocked': 'Not docked',
        'settings.ghosts.detail.cindyPrefs.noModels': 'No models available',
      };
      return labels[key] ?? key;
    },
  }),
}));

import type { GhostPermissionItem } from '../../../../shared/ghost';
import { CindyCapabilityPrefs } from '@/cindy-brain/CindyCapabilityPrefs';
import {
  DetailsSection,
  GhostPluginDetailView,
  GhostPluginMetadata,
  PermissionSummary,
  ToolDescriptionChip,
  ToolsSection,
} from '../GhostPluginDetailView';
import type { GhostPluginDetail } from '../lib/ghostPluginViewModel';

const permissions: GhostPermissionItem[] = [
  {
    key: 'network:api.example.com',
    kind: 'network',
    labelKey: 'networkHost',
    labelArgs: { host: 'api.example.com' },
    detailKey: 'networkHostDetail',
  },
  {
    key: 'command:render',
    kind: 'command',
    labelKey: 'command',
    labelArgs: { command: 'render' },
  },
  {
    key: 'tool:render',
    kind: 'tool',
    labelKey: 'tool',
    labelArgs: { name: 'render' },
    detail: 'Render an image.',
  },
  {
    key: 'cindy:image.generate',
    kind: 'cindy',
    labelKey: 'cindyImageGenerate',
  },
];

const detail: GhostPluginDetail = {
  id: 'builtin.example',
  name: 'Example',
  description: 'Example plugin',
  version: '1.2.3',
  enabled: true,
  canUse: true,
  author: 'XD',
  contents: ['code'],
  permissions: [],
  tools: [],
  hasSettingsUi: false,
  cindyCapabilities: [],
  panelMinWidth: 320,
  installDir: '/tmp/cindy-brain/builtin.example',
  trust: {
    level: 'cindy-official',
    publisherSigned: true,
    publisherVerified: true,
    reviewed: true,
    publisherName: 'Cindy',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Ghost plugin detail sections', () => {
  it('keeps the detail surface on one centered content grid', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const { container } = render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const scrollSurface = container.querySelector('main');
    const detailFrame = container.querySelector('article');
    const backButton = detailFrame?.querySelector(':scope > button');
    const detailHero = detailFrame?.querySelector('.plugin-detail-hero');
    const detailActions = detailFrame?.querySelector('.plugin-detail-actions');
    expect(scrollSurface?.className).toContain('[scrollbar-gutter:stable_both-edges]');
    expect(detailFrame?.className).toContain('plugin-detail-frame');
    expect(detailFrame?.className).toContain('mx-auto');
    expect(detailFrame?.className).toContain('max-w-[824px]');
    expect(backButton?.className).toContain('-ml-3');
    expect(detailHero?.className).toContain('grid-cols-[64px_minmax(0,1fr)_auto]');
    expect(detailActions?.className).toContain('flex-nowrap');
  });

  it('disables every market update entry while an update is busy', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onUpdate = vi.fn();

    render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={onUpdate}
        updateLabel="Update from market"
        updateVersion="1.2.4"
        updateBusy
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    expect(
      (screen.getByRole('button', {
        name: 'settings.ghosts.market.updateTo',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    const menuUpdate = screen.getByRole('menuitem', { name: 'Update from market' });
    expect(menuUpdate.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(menuUpdate);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('uses one metadata color and orders author, then version', () => {
    const { container } = render(<GhostPluginMetadata author="Cindy" version="1.1.4" />);

    const metadata = container.firstElementChild as HTMLElement;
    expect(metadata.textContent).toBe('By Cindy·v1.1.4');
    expect(metadata.className).toContain('text-[var(--text-tertiary)]');
    expect(metadata.innerHTML).not.toContain('text-[var(--text-secondary)]');
    expect(screen.getByText('By Cindy').className).toContain('min-w-0');
    expect(screen.getByText('By Cindy').className).toContain('truncate');
  });

  it('marks Cindy model preferences as a card-width responsive control group', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: {},
            image: {
              options: [{ id: 'image-default', label: 'Image Default' }],
              defaultModel: { id: 'image-default', label: 'Image Default' },
            },
            video: {
              options: [{ id: 'video-default', label: 'Video Default' }],
              defaultModel: { id: 'video-default', label: 'Video Default' },
            },
          }),
          setCindyPref: vi.fn(),
        },
      },
    });

    const { container } = render(
      <CindyCapabilityPrefs
        ghostId="builtin.example"
        capabilities={['image.generate']}
        appearance="plugin"
      />,
    );

    expect(container.querySelector('.cindy-capability-prefs')).toBeTruthy();
    expect(container.querySelector('.cindy-capability-row')).toBeTruthy();
    const select = screen.getByRole('combobox');
    expect(select.className).toContain('cindy-capability-select');
    expect(select.className).toContain('max-w-[60%]');
  });

  it('replaces the select with tertiary copy for ability categories the catalog has no models for', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: { 'video.generate': 'retired-video-model' },
            image: {
              options: [{ id: 'image-default', label: 'Image Default' }],
              defaultModel: { id: 'image-default', label: 'Image Default' },
            },
            // 目录没给视频清单 = 能力暂不可用。
            video: { options: [], defaultModel: null },
          }),
          setCindyPref: vi.fn(),
        },
      },
    });

    const { container } = render(
      <CindyCapabilityPrefs
        ghostId="builtin.example"
        capabilities={['image.generate', 'video.generate', 'video.edit']}
        appearance="plugin"
      />,
    );

    // 三行都在(插件确实申请了这三项能力),但只有图像那行给下拉。
    expect(container.querySelectorAll('.cindy-capability-row')).toHaveLength(3);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    const empties = container.querySelectorAll('.cindy-capability-empty');
    expect(empties).toHaveLength(2);
    empties.forEach((node) => {
      expect(node.textContent).toBe('No models available');
      expect(node.className).toContain('text-[var(--text-tertiary)]');
    });
  });

  it('shows only the Tool description after an explicit click', async () => {
    render(
      <ToolDescriptionChip
        tool={{
          name: 'render_image',
          description: 'Render an image from the current prompt.',
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
          },
        }}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Open render_image' });
    fireEvent.mouseEnter(trigger);
    fireEvent.focus(trigger);
    expect(screen.queryByText('Render an image from the current prompt.')).toBeNull();

    fireEvent.click(trigger);

    expect(await screen.findByText('Render an image from the current prompt.')).toBeTruthy();
    expect(screen.queryByText('prompt')).toBeNull();
    expect(screen.queryByText('JSON Schema')).toBeNull();
  });

  it('keeps the Tools title count-free and puts See All beside the title', () => {
    render(
      <ToolsSection
        tools={Array.from({ length: 7 }, (_, index) => ({
          name: `tool_${index}`,
          description: `Tool ${index}`,
        }))}
      />,
    );

    const heading = screen.getByRole('heading', { name: 'Tools' });
    expect(heading).toBeTruthy();
    expect(heading.closest('section')?.className).not.toContain('border-t');
    expect(screen.queryByRole('heading', { name: /Tools.*7/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'See All' })).toBeTruthy();
  });

  it('shows every host permission except Tools and opens the same complete details', async () => {
    render(<PermissionSummary items={permissions} />);

    const networkLabel = screen.getByText('Access api.example.com');
    const permissionCard = networkLabel.closest('button');
    const commandLabel = screen.getByText('Command render');
    const cindyLabel = screen.getByText('Generate images');
    expect(permissionCard).toBeTruthy();
    expect(commandLabel.closest('button')).toBe(permissionCard);
    expect(cindyLabel.closest('button')).toBe(permissionCard);
    expect(within(permissionCard as HTMLButtonElement).queryByText('Tool render')).toBeNull();
    expect(permissionCard?.className).toContain('grid-cols-2');
    expect(permissionCard?.className).toContain('var(--surface-elevated)');
    expect(permissionCard?.className).toContain('p-4');
    expect(permissionCard?.className).toContain('gap-y-0');
    expect(networkLabel.parentElement?.className).toContain('min-h-9');
    expect(networkLabel.className).toContain('text-13');
    expect(networkLabel.className).toContain('font-normal');
    expect(networkLabel.className).toContain('break-words');
    expect(networkLabel.className).not.toContain('truncate');
    expect(networkLabel.className).not.toContain('font-medium');

    fireEvent.click(permissionCard as HTMLButtonElement);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.lucide-globe')).toBeTruthy();
    expect(dialog.innerHTML).toContain('border-b-[0.5px]');
    expect(dialog.innerHTML).toContain('divide-y-[0.5px]');
    expect(within(dialog).getByText('Access api.example.com')).toBeTruthy();
    expect(within(dialog).getByText('Can access this declared domain.')).toBeTruthy();
    expect(within(dialog).getByText('Command render')).toBeTruthy();
    expect(within(dialog).queryByText('Tool render')).toBeNull();
    expect(within(dialog).getByText('Generate images')).toBeTruthy();
  });

  it('uses the same elevated theme surface for Tool bubbles and Permission cards', () => {
    render(
      <>
        <ToolDescriptionChip tool={{ name: 'render_image', description: 'Render an image.' }} />
        <PermissionSummary items={permissions} />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Open render_image' }).className).toContain(
      'var(--surface-elevated)',
    );
    expect(screen.getByText('Access api.example.com').closest('button')?.className).toContain(
      'var(--surface-elevated)',
    );
  });

  it('renders every detail fact in a three-column flat grid and copies the install location', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<DetailsSection detail={detail} panelStatus="Docked" />);

    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByText('Author')).toBeTruthy();
    expect(screen.getByText('Identifier')).toBeTruthy();
    const detailsGrid = screen.getByText('Version').parentElement?.parentElement;
    expect(detailsGrid?.className).toContain('grid-cols-3');
    expect(detailsGrid?.className).not.toContain('border');
    expect(screen.getByText('v1.2.3').className).toContain('truncate');
    expect(screen.getByText('Contents')).toBeTruthy();
    expect(screen.queryByText('Source')).toBeNull();
    expect(screen.getByText('Panel')).toBeTruthy();
    expect(screen.getByText('Install Location')).toBeTruthy();
    const installLocation = screen.getByText('/tmp/cindy-brain/builtin.example');
    expect(installLocation.className).toContain('truncate');
    expect(installLocation.className).toContain('whitespace-nowrap');
    expect(screen.queryByRole('button', { name: 'See All' })).toBeNull();

    const expandButton = screen.getByRole('button', { name: 'Show full Install Location' });
    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandButton);
    expect(installLocation.className).toContain('whitespace-pre-wrap');
    expect(installLocation.className).not.toContain('truncate');
    const collapseButton = screen.getByRole('button', { name: 'Collapse Install Location' });
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapseButton);
    expect(installLocation.className).toContain('truncate');
    expect(installLocation.className).toContain('whitespace-nowrap');

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Location' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/cindy-brain/builtin.example'));

    const openPath = vi.fn().mockResolvedValue({ success: false, error: 'file locked' });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openPath },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Install Location' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/tmp/cindy-brain/builtin.example'));
    expect(toastMocks.error).toHaveBeenCalledWith('settings.ghosts.errors.generic');
  });

  it('does not add expand controls when detail values fit on one line', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100);

    render(<DetailsSection detail={detail} panelStatus="Docked" />);

    expect(screen.queryByRole('button', { name: /Show full/ })).toBeNull();
  });

  it('keeps host permission guidance and author-provided OAuth scopes together', async () => {
    render(
      <PermissionSummary
        items={[
          permissions[0],
          {
            key: 'network:oauth',
            kind: 'network',
            labelKey: 'networkSecretOauth',
            detailKey: 'networkHostDetail',
            detail: 'scope.read\nscope.write',
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByText('Access api.example.com').closest('button') as HTMLButtonElement,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Can access this declared domain.')).toHaveLength(2);
    expect(
      within(dialog).getByText((_, element) => element?.textContent === 'scope.read\nscope.write'),
    ).toBeTruthy();
  });
});
