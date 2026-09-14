import { describe, expect, it } from 'vitest';

import {
  buildInteractiveCardV1,
  FEISHU_V1_ACTION_MAX_COMPONENTS,
} from '../cards.js';
import type { InteractiveCardSpec } from '../../types.js';

function specWithButtons(count: number): InteractiveCardSpec {
  return {
    title: 't',
    body: 'b',
    buttons: Array.from({ length: count }, (_, i) => ({
      id: `btn:${i}`,
      label: `L${i}`,
      type: i === count - 1 ? ('primary' as const) : ('default' as const),
      payload: { n: i },
    })),
  };
}

function actionModules(card: unknown): Array<{ tag: string; actions: unknown[] }> {
  const elements = (card as { elements: Array<{ tag: string; actions?: unknown[] }> }).elements;
  return elements.filter((el) => el.tag === 'action') as Array<{ tag: string; actions: unknown[] }>;
}

describe('buildInteractiveCardV1 action 模块拆分', () => {
  it('不超过上限时仍是一个 action 模块', () => {
    const card = buildInteractiveCardV1(specWithButtons(FEISHU_V1_ACTION_MAX_COMPONENTS));
    const actions = actionModules(card);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actions).toHaveLength(FEISHU_V1_ACTION_MAX_COMPONENTS);
  });

  it('两道各 3 选项 + 提交共 7 钮拆成两模块, 每模块不超过 5', () => {
    const card = buildInteractiveCardV1(specWithButtons(7));
    const actions = actionModules(card);
    expect(actions).toHaveLength(2);
    expect(actions[0]!.actions).toHaveLength(5);
    expect(actions[1]!.actions).toHaveLength(2);
    expect(actions.every((mod) => mod.actions.length <= FEISHU_V1_ACTION_MAX_COMPONENTS)).toBe(true);
  });

  it('保持按钮顺序与 payload', () => {
    const card = buildInteractiveCardV1(specWithButtons(7));
    const labels = actionModules(card).flatMap((mod) =>
      (mod.actions as Array<{ text: { content: string }; value: { id: string; n: number } }>).map(
        (btn) => ({ id: btn.value.id, n: btn.value.n, label: btn.text.content }),
      ),
    );
    expect(labels).toEqual(
      Array.from({ length: 7 }, (_, i) => ({ id: `btn:${i}`, n: i, label: `L${i}` })),
    );
  });
});
