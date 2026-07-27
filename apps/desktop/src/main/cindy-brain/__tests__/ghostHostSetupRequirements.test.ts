import { beforeEach, describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { setMainLocale } from '../../i18n';
import { assessGhostHostSetupRequirements } from '../ghostHostSetupRequirements';

function manifest(id: string, cindy = false): GhostManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    version: '1',
    kind: 'chip',
    entry: 'main.js',
    slots: cindy ? ['tool', 'cindy'] : ['tool'],
    tools: [{ name: 'run', description: 'run' }],
    ...(cindy ? { cindy: { image: ['generate' as const] } } : {}),
  };
}

describe('assessGhostHostSetupRequirements', () => {
  beforeEach(() => {
    setMainLocale('en');
  });

  it('maps any declared Host media capability to a generic client_config action', () => {
    const groups = assessGhostHostSetupRequirements(manifest('media-plugin', true), {
      clientConfigReady: () => false,
    });
    expect(groups).toEqual([
      {
        id: 'host:client_config:model-provider',
        mode: 'any_of',
        items: [
          {
            ref: 'client_config:model-provider',
            kind: 'client_config',
            label: 'AI Model Service',
            description:
              'Connect an available model service before using the image or video capabilities declared by this plugin.',
            state: 'missing',
            actions: [
              {
                id: 'open_client_settings:client_config:model-provider',
                kind: 'open_client_settings',
              },
            ],
          },
        ],
      },
    ]);
  });

  it.each([
    ['zh-CN', 'AI 模型服务', '使用插件声明的图片或视频能力前，需要先连接可用的模型服务'],
    [
      'ja',
      'AIモデルサービス',
      'プラグインが宣言した画像または動画機能を使用する前に、利用可能なモデルサービスへ接続してください。',
    ],
    [
      'ko',
      'AI 모델 서비스',
      '플러그인에서 선언한 이미지 또는 동영상 기능을 사용하기 전에 사용 가능한 모델 서비스에 연결하세요.',
    ],
  ] as const)('localizes Host-owned capability copy for %s', (locale, label, description) => {
    setMainLocale(locale);
    const groups = assessGhostHostSetupRequirements(manifest('localized-media-plugin', true), {
      clientConfigReady: () => false,
    });

    expect(groups[0].items[0]).toMatchObject({ label, description });
  });

  it('reports ready without an executable action when the owning subsystem is ready', () => {
    const groups = assessGhostHostSetupRequirements(manifest('another-media-plugin', true), {
      clientConfigReady: (configId) => configId === 'model-provider',
    });
    expect(groups[0].items[0]).toMatchObject({ state: 'satisfied', actions: [] });
  });

  it('does not impose Host configuration on plugins without the declared capability', () => {
    expect(
      assessGhostHostSetupRequirements(manifest('gmail'), {
        clientConfigReady: () => false,
      }),
    ).toEqual([]);
  });
});
