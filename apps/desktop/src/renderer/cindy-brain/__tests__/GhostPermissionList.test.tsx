// @vitest-environment jsdom
/**
 * GhostPermissionList.test.tsx — 装入/更新确认框权限清单组件。
 * 条目推导已在 shared/__tests__/ghost.test.ts 锁死,这里只验展示契约:
 * 装入清单逐项渲染(含作者自由文本 detail 与主机固定说明 detailKey)、
 * 更新 diff 只亮变化项 + 不变折叠、权限无变化的收敛文案。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { diffGhostPermissionItems, ghostPermissionItems } from '../../../shared/ghost';
import {
  GhostInstallReview,
  GhostPermissionDiffView,
  GhostPermissionList,
} from '../GhostPermissionList';

// 仓库同款 i18n mock:t 返回 key 本身(带参时拼上参数便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

afterEach(cleanup);

const chip = (): GhostManifest => ({
  schemaVersion: 2,
  id: 'art-like',
  name: '画图',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['panel', 'cindy', 'tool'],
  cindy: { image: ['generate', 'edit'] },
  tools: [{ name: 'gen_image', description: '根据描述出图' }],
  command: '画图',
  panel: { title: '画廊', html: 'panel.html' },
});

describe('GhostPermissionList(装入全量清单)', () => {
  it('常规权限直接展示,工具长说明默认折叠并可按需展开', () => {
    render(<GhostPermissionList items={ghostPermissionItems(chip())} />);
    expect(screen.getByText('settings.ghosts.perm.grantsTitle')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.cindyImageGenerate')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.cindyImageEdit')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.toolsGroup')).toBeTruthy();
    expect(screen.queryByText(/perm\.tool:.*gen_image/)).toBeNull();
    expect(screen.queryByText('根据描述出图')).toBeNull();
    const toolsTrigger = screen.getByRole('button', { expanded: false });
    fireEvent.click(toolsTrigger);
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    expect(screen.getByText(/perm\.tool:.*gen_image/)).toBeTruthy();
    expect(screen.getByText('根据描述出图')).toBeTruthy(); // 作者自由文本如实展示
    expect(screen.getByText(/perm\.command:.*画图/)).toBeTruthy();
    expect(screen.getByText(/perm\.panelRight:.*画廊/)).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.code')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.codeDetail')).toBeTruthy(); // 主机固定说明走 i18n
  });

  it('安装简介过长时默认收起,可展开完整原文', () => {
    const description = '这是很长的意识介绍。'.repeat(20);
    const { container } = render(
      <GhostInstallReview
        description={description}
        meta="作者 Cindy · 版本 1.0.0"
        trust={{
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        }}
        items={[]}
      />,
    );
    const scrollArea = container.firstElementChild as HTMLElement;
    expect(scrollArea.classList.contains('overflow-y-auto')).toBe(true);
    expect(scrollArea.style.maxHeight).toBe('min(56vh, 520px)');
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger.textContent).toBe('settings.ghosts.installConfirm.expandDescription');
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { expanded: true }).textContent).toBe(
      'settings.ghosts.installConfirm.collapseDescription',
    );
    expect(screen.getByText('作者 Cindy · 版本 1.0.0')).toBeTruthy();
  });

  it('空清单渲染为空(不出孤零零的标题)', () => {
    const { container } = render(<GhostPermissionList items={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('network 槽:域名/凭证逐条渲染,code 沙箱说明切分档版', () => {
    const net: GhostManifest = {
      ...chip(),
      slots: [...chip().slots, 'network'],
      network: {
        hosts: ['api.search.brave.com', '*.tavily.com'],
        secrets: [
          {
            key: 'brave_api_key',
            label: 'Brave Key',
            inject: { header: 'X-Subscription-Token', format: '{value}' },
          },
        ],
      },
    };
    render(<GhostPermissionList items={ghostPermissionItems(net)} />);
    expect(screen.getByText(/perm\.networkHost:.*api\.search\.brave\.com/)).toBeTruthy();
    expect(screen.getByText(/perm\.networkHost:.*\*\.tavily\.com/)).toBeTruthy();
    expect(screen.getByText(/perm\.networkSecret:.*Brave Key/)).toBeTruthy();
    // user 凭证只剩意识收单档(宿主凭证渲染 2026-07-13 退役)。
    expect(screen.getByText('settings.ghosts.perm.networkSecretGhostInputDetail')).toBeTruthy();
    // "无网络访问"的旧说明对 network 意识是假话,必须换分档版。
    expect(screen.getByText('settings.ghosts.perm.codeDetailNetwork')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.perm.codeDetail')).toBeNull();
  });

  it('Node 持久凭证单独披露明文注入范围', () => {
    const node: GhostManifest = {
      ...chip(),
      slots: [...chip().slots, 'node'],
      settingsHtml: 'settings.html',
      node: {
        entry: 'worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_authorization_code',
            label: '邮箱授权码',
            methods: ['account/connect', 'mail/action'],
          },
        ],
      },
    };
    render(<GhostPermissionList items={ghostPermissionItems(node)} />);
    expect(screen.getByText(/perm\.nodeSecret:.*邮箱授权码/)).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.nodeSecretDetail')).toBeTruthy();
    expect(screen.getByText(/account\/connect\s+mail\/action/)).toBeTruthy();
  });
});

describe('GhostPermissionDiffView(更新权限 diff)', () => {
  it('只亮变化项:新增/移除带徽章,不变项折叠成计数行', () => {
    const next: GhostManifest = {
      ...chip(),
      version: '2.0.0',
      cindy: { image: ['generate'] }, // 移除 edit
      tools: [...(chip().tools ?? []), { name: 'style_image', description: '风格化' }], // 新增
    };
    render(<GhostPermissionDiffView diff={diffGhostPermissionItems(chip(), next)} />);
    expect(screen.getByText(/perm\.tool:.*style_image/)).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.added')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.cindyImageEdit')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.removed')).toBeTruthy();
    expect(screen.getByText(/perm\.unchanged:.*"count":5/)).toBeTruthy();
    // 不变项本体不渲染(折叠):cindyImageGenerate 不该出现在行里。
    expect(screen.queryByText('settings.ghosts.perm.cindyImageGenerate')).toBeNull();
  });

  it('权限无变化 → 单行收敛文案,无任何条目', () => {
    render(
      <GhostPermissionDiffView
        diff={diffGhostPermissionItems(chip(), { ...chip(), version: '1.0.1' })}
      />,
    );
    expect(screen.getByText('settings.ghosts.perm.noChange')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.perm.added')).toBeNull();
    expect(screen.queryByText('settings.ghosts.perm.unchanged', { exact: false })).toBeNull();
  });
});
