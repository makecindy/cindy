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
  GhostUpdateReview,
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
    expect(screen.getByText(/perm\.panelLeft:.*画廊/)).toBeTruthy();
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
    // 限高与滚动由共享 ConfirmDialog 持有,本组件不许再自套一层滚动容器
    // (两层限高 → "到底了没有"取决于谁先触底)。
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('overflow-y-auto')).toBe(false);
    expect(root.style.maxHeight).toBe('');
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

  it('Cindy Web Search 能力在安装权限清单中单独披露', () => {
    const search: GhostManifest = {
      ...chip(),
      cindy: { search: ['web'] },
    };
    render(<GhostPermissionList items={ghostPermissionItems(search)} />);
    expect(screen.getByText('settings.ghosts.perm.cindySearchWeb')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.cindySearchWebDetail')).toBeTruthy();
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
  it('只亮变化项:非工具变化直接带徽章,工具变化折叠计数,不变项折叠成计数行', () => {
    const next: GhostManifest = {
      ...chip(),
      version: '2.0.0',
      cindy: { image: ['generate'] }, // 移除 edit
      tools: [...(chip().tools ?? []), { name: 'style_image', description: '风格化' }], // 新增
    };
    render(<GhostPermissionDiffView diff={diffGhostPermissionItems(chip(), next)} />);
    // 非工具的敏感变化直接亮出来。
    expect(screen.getByText('settings.ghosts.perm.cindyImageEdit')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.removed')).toBeTruthy();
    // 工具变化只报数量,原文要展开才看;新增徽章跟着行进折叠区。
    expect(screen.getByText('settings.ghosts.perm.toolsDiffGroup')).toBeTruthy();
    expect(screen.getByText(/perm\.itemCount:.*"count":1/)).toBeTruthy();
    expect(screen.queryByText(/perm\.tool:.*style_image/)).toBeNull();
    expect(screen.queryByText('settings.ghosts.perm.added')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/perm\.tool:.*style_image/)).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.added')).toBeTruthy();
    expect(screen.getByText(/perm\.unchanged:.*"count":5/)).toBeTruthy();
    // 不变项本体不渲染(折叠):cindyImageGenerate 不该出现在行里。
    expect(screen.queryByText('settings.ghosts.perm.cindyImageGenerate')).toBeNull();
  });

  it('只改了工具说明时,2N 条工具行全部收进折叠区,不挤走真正的权限变化', () => {
    const prev: GhostManifest = {
      ...chip(),
      tools: [
        { name: 'gen_image', description: '旧说明 A' },
        { name: 'style_image', description: '旧说明 B' },
      ],
    };
    const next: GhostManifest = {
      ...prev,
      version: '2.0.0',
      // 工具说明重写 → diff 记成「移除旧行 + 新增新行」,2 个工具产出 4 行。
      tools: [
        { name: 'gen_image', description: '新说明 A（整段接口文档）' },
        { name: 'style_image', description: '新说明 B（整段接口文档）' },
      ],
      slots: [...prev.slots, 'network'],
      network: { hosts: ['api.example.com'] },
    };
    render(<GhostPermissionDiffView diff={diffGhostPermissionItems(prev, next)} />);
    // 真正的权限变化(新增网络域名)仍在折叠区之外,第一屏就能看到。
    expect(screen.getByText(/perm\.networkHost:.*api\.example\.com/)).toBeTruthy();
    expect(screen.getByText('settings.ghosts.perm.added')).toBeTruthy();
    // 4 条工具行收进一个折叠组,原文默认不渲染。
    expect(screen.getByText(/perm\.itemCount:.*"count":4/)).toBeTruthy();
    expect(screen.queryByText('新说明 A（整段接口文档）')).toBeNull();
    expect(screen.queryByText('旧说明 B')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('新说明 A（整段接口文档）')).toBeTruthy();
    expect(screen.getByText('旧说明 B')).toBeTruthy();
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

describe('GhostUpdateReview(更新确认内容区,两个入口共用)', () => {
  const next = (): GhostManifest => ({
    ...chip(),
    version: '2.0.0',
    slots: [...chip().slots, 'network'],
    network: { hosts: ['api.example.com'] },
  });

  it('传了 trust 就渲染来源卡,并与 diff 同时展示', () => {
    render(
      <GhostUpdateReview
        trust={{
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        }}
        diff={diffGhostPermissionItems(chip(), next())}
      />,
    );
    expect(screen.getByText(/trust\.unsigned:/)).toBeTruthy(); // 带 publisher 参数的标题行
    expect(screen.getByText('settings.ghosts.trust.unsignedDetail')).toBeTruthy();
    expect(screen.getByText(/perm\.networkHost:.*api\.example\.com/)).toBeTruthy();
  });

  it('没有可展示的来源事实时不渲染来源卡,也不拿假数据占位', () => {
    render(<GhostUpdateReview diff={diffGhostPermissionItems(chip(), next())} />);
    expect(screen.queryByText(/trust\.unsigned/)).toBeNull();
    expect(screen.queryByText(/trust\.unknownPublisher/)).toBeNull();
    expect(screen.getByText(/perm\.networkHost:.*api\.example\.com/)).toBeTruthy();
  });

  it('不自套限高滚动区(高度归共享 ConfirmDialog)', () => {
    const { container } = render(<GhostUpdateReview diff={diffGhostPermissionItems(chip(), next())} />);
    const scrollers = container.querySelectorAll('.overflow-y-auto');
    expect(scrollers.length).toBe(0);
  });
});
