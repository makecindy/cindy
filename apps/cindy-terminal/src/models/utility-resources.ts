import type {
  RemoteActionDescriptor,
  RemoteResourceRegistry,
  RemoteText,
} from '@cindy/device-link';
import type { TerminalUtilityModels } from './utility.js';

const text = (
  en: string,
  zh: string,
  tw: string,
  ja: string,
  ko: string,
): RemoteText => ({
  fallback: en,
  translations: { en, 'zh-CN': zh, 'zh-TW': tw, ja, ko },
});
export const auxiliaryModelsTitle = text(
  'Auxiliary models',
  '辅助模型',
  '輔助模型',
  '補助モデル',
  '보조 모델',
);
const automatic = text('Automatic', '自动', '自動', '自動', '자동');
const none = text('None', '不选', '不選', 'なし', '없음');
const edit = text(
  'Edit model order',
  '编辑模型顺序',
  '編輯模型順序',
  'モデルの順序を編集',
  '모델 순서 편집',
);
const reset = text(
  'Restore defaults',
  '恢复默认',
  '還原預設',
  '既定に戻す',
  '기본값 복원',
);
const slots = [
  text('Primary model', '首选模型', '首選模型', '優先モデル', '기본 모델'),
  text(
    'Second model',
    '第二模型',
    '第二模型',
    '2 番目のモデル',
    '두 번째 모델',
  ),
  text('Third model', '第三模型', '第三模型', '3 番目のモデル', '세 번째 모델'),
];

/** Shared resources make the same settings editable from local/remote TUI and GUI. */
export function registerUtilityModelResources(
  registry: RemoteResourceRegistry,
  utility: TerminalUtilityModels,
) {
  const ref = {
    collectionId: 'auxiliary-models',
    kind: 'auxiliary-models',
    id: 'chain',
  };
  async function resource() {
    const state = await utility.state();
    const options = [
      { value: '', label: none },
      ...state.options.map((option) => ({
        value: option.id,
        label: option.label,
      })),
    ];
    const actions: RemoteActionDescriptor[] = [
      {
        id: 'edit',
        label: edit,
        fields: slots.map((label, index) => ({
          id: `model${index + 1}`,
          kind: 'select' as const,
          label,
          options,
        })),
      },
      { id: 'reset', label: reset },
    ];
    return {
      ref,
      revision: JSON.stringify(state.models),
      display: {
        title: auxiliaryModelsTitle,
        ...(state.models.length ? {} : { subtitle: automatic }),
      },
      links: [],
      actions,
      blocks: [
        {
          id: 'chain',
          primitive: 'text',
          fallbackMarkdown: state.effective.refs
            .map(
              (id, index) =>
                `${index + 1}. ${state.options.find((option) => option.id === id)?.label ?? id}`,
            )
            .join('\n'),
        },
        {
          id: 'settings',
          primitive: 'form',
          fallbackMarkdown: '',
          data: {
            actionId: 'edit',
            values: Object.fromEntries(
              slots.map((_, index) => [
                `model${index + 1}`,
                state.models[index] ?? '',
              ]),
            ),
          },
        },
      ],
    };
  }
  registry.register({
    collection: {
      id: ref.collectionId,
      resourceKind: ref.kind,
      title: auxiliaryModelsTitle,
      placement: 'settings',
    },
    list: async () => {
      const item = await resource();
      return {
        collectionId: ref.collectionId,
        revision: item.revision,
        items: [item],
      };
    },
    get: async (_context, request) => {
      if (request.ref.id !== ref.id) throw new Error('RESOURCE_NOT_FOUND');
      return resource();
    },
    invoke: async (context, request) => {
      context.assertCurrent?.();
      if (request.resourceRef?.id !== ref.id)
        throw new Error('RESOURCE_NOT_FOUND');
      if (request.actionId === 'reset')
        await utility.update({ models: [] }, context.assertCurrent);
      else if (request.actionId === 'edit') {
        const input = request.input;
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => !/^model[123]$/.test(key))
        )
          throw new Error('INVALID_AUXILIARY_SETTINGS');
        const values = input as Record<string, unknown>;
        const models = slots
          .map((_, index) => values[`model${index + 1}`])
          .filter((value) => value !== '' && value !== undefined);
        await utility.update({ models }, context.assertCurrent);
      } else throw new Error('INVALID_ACTION');
      return { effects: [{ kind: 'refresh-resource', ref }] };
    },
  });
}
