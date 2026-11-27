/**
 * The cover page shared by the get-started guide and feature introductions (DESIGN.md
 * "Get-started guide" and "Feature introduction"): a mark, a headline, one sentence, three cards
 * whose small scenes play once, and a single centered action. Lives inside a Radix Dialog.
 */
import type { CSSProperties, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export interface GuideCoverCard {
  id: string;
  title: string;
  body: string;
  /** A small scene made of the product's own elements; `start` is when it may begin (ms). */
  scene: (start: number) => ReactNode;
}

// Cover choreography (DESIGN.md §14.4, get-started guide entrance). The blocks arrive briskly,
// top first; each card's scene then plays once and carries the part worth watching. Delays are
// in ms from the moment the cover mounts and mirror `.first-run-cover` in globals.css.
const COVER_RISE_STEP = 45;
const COVER_CARD_INDEX = 3;

function coverRise(index: number): CSSProperties {
  return { '--rise-index': index } as CSSProperties;
}

/** When a card's scene starts: once that card has arrived. */
function coverSceneStart(card: number): number {
  return (COVER_CARD_INDEX + card) * COVER_RISE_STEP + 150;
}

/** Start time of one element in a scene (`.first-run-pop` / `-draw` / `-leave` / `-shift`). */
export function at(ms: number): CSSProperties {
  return { '--at': `${ms}ms` } as CSSProperties;
}

export function GuideCover({ mark, title, lead, cards, action, note, close }: {
  mark: ReactNode;
  title: string;
  lead: string;
  cards: readonly GuideCoverCard[];
  action: ReactNode;
  /** One short line under the action. */
  note?: string;
  close: ReactNode;
}) {
  return (
    <div className="first-run-cover relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-8">
      <div className="absolute right-3 top-3">{close}</div>
      <div className="first-run-rise" style={coverRise(0)}>{mark}</div>
      <Dialog.Title asChild>
        <h2 className="first-run-rise mt-7 text-center text-28 font-medium leading-tight text-[var(--confirm-title)]" style={coverRise(1)}>
          {title}
        </h2>
      </Dialog.Title>
      <p className="first-run-rise mt-2 max-w-[440px] text-center text-15 leading-relaxed text-[var(--confirm-desc)]" style={coverRise(2)}>
        {lead}
      </p>
      <ul className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map((card, position) => (
          <li key={card.id} className="first-run-rise flex flex-col rounded-xl border border-[var(--border-default)] p-2" style={coverRise(COVER_CARD_INDEX + position)}>
            {/* A small scene made of the product's own elements instead of a generic icon. */}
            <div className="flex h-[88px] items-center justify-center rounded-lg bg-[var(--surface-chip)]" aria-hidden="true">
              {card.scene(coverSceneStart(position))}
            </div>
            <div className="flex flex-col gap-1 px-2 pb-2 pt-3">
              <span className="text-14 font-medium text-[var(--confirm-title)]">{card.title}</span>
              <span className="text-13 leading-relaxed text-[var(--confirm-desc)]">{card.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="first-run-rise mt-8 shrink-0" style={coverRise(COVER_CARD_INDEX + cards.length)}>
        {action}
      </div>
      {note ? (
        <p className="first-run-rise mt-3 text-center text-12 text-[var(--text-tertiary)]" style={coverRise(COVER_CARD_INDEX + cards.length + 1)}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
