import { describe, expect, it } from 'vitest';

import {
  DESKTOP_TASK_LIST_SESSION_SOURCES,
  DESKTOP_VISIBLE_SESSION_SOURCES,
} from '../../shared/sessionSource';

describe('attached task visibility', () => {
  it('keeps review and side-chat tasks readable but out of the ordinary task list', () => {
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('review');
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('side-chat');
    expect(DESKTOP_TASK_LIST_SESSION_SOURCES).not.toContain('review');
    expect(DESKTOP_TASK_LIST_SESSION_SOURCES).not.toContain('side-chat');
    expect(DESKTOP_TASK_LIST_SESSION_SOURCES).toEqual(
      DESKTOP_VISIBLE_SESSION_SOURCES.filter((source) => source !== 'review' && source !== 'side-chat'),
    );
  });
});
