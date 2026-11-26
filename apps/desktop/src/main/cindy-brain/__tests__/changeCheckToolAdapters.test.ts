import { describe, expect, it, vi } from 'vitest';
import { legacyChangeCheckSource, probeExistingGoogleTools } from '../changeCheckToolAdapters';
import type { InstalledGhost } from '../../../shared/ghost';

// Unit: existing plugins have no change-check declaration. Exercise their exact
// read contracts, incomplete pages and account changes without real accounts.
const window = {
  providerId: 'source',
  source: 'mail',
  from: '2026-11-08T00:00:00Z',
  to: '2026-11-09T00:00:00Z',
};
const ok = (result: unknown) => ({ ok: true, result });
const accounts = ok({
  accounts: [
    { id: 'a', status: 'connected' },
    { id: 'b', status: 'connected' },
  ],
});

describe('existing Google plugin read adapters', () => {
  it('recognizes only approved root installations with both existing tools', () => {
    const ghost = {
      enabled: true,
      namespace: null,
      approval: { state: 'approved' },
      manifest: {
        id: 'google-gmail',
        tools: [{ name: 'gmail_accounts' }, { name: 'gmail_run' }],
      },
    } as InstalledGhost;
    expect(legacyChangeCheckSource(ghost)).toBe('mail');
    expect(legacyChangeCheckSource({ ...ghost, namespace: 'other' })).toBeNull();
    expect(legacyChangeCheckSource({ ...ghost, enabled: false })).toBeNull();
    expect(
      legacyChangeCheckSource({ ...ghost, manifest: { ...ghost.manifest, tools: [] } }),
    ).toBeNull();
  });

  it.each(['empty', 'changed', 'denied', 'truncated', 'account-added'] as const)(
    'checks each mailbox without bodies: %s',
    async (mode) => {
      let accountReads = 0;
      const read = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'gmail_accounts')
          return mode === 'account-added' && ++accountReads > 1
            ? ok({ accounts: [{ id: 'new', status: 'connected' }] })
            : accounts;
        expect(tool).toBe('gmail_run');
        expect(args).toMatchObject({
          command: ['messages', 'search'],
          options: { max: 1 },
          session_context: {
            session_id: null,
            workdir: null,
            workdir_is_local: false,
            workdir_is_read_only: true,
          },
        });
        if (args.account === 'b' && mode === 'denied') return { ok: false };
        return ok({
          messages: args.account === 'b' && mode === 'changed' ? [{ id: 'new' }] : [],
          nextPageToken: '',
          ...(mode === 'truncated' ? { truncated: true } : {}),
        });
      });
      expect(await probeExistingGoogleTools('mail', window, read)).toBe(
        mode === 'empty' ? 'unchanged' : mode === 'changed' ? 'changed' : 'unknown',
      );
      for (const [, args] of read.mock.calls)
        expect(args).not.toHaveProperty('options.include-body');
    },
  );

  it.each(['empty', 'changed', 'unlisted-calendar', 'denied', 'bad-shape'] as const)(
    'does not hide incomplete calendar coverage: %s',
    async (mode) => {
      const read = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'google_calendar_accounts') return accounts;
        if ((args.command as string[])[0] === 'calendars')
          return ok({
            calendars: [{ id: 'primary' }, { id: 'team' }],
            nextPageToken: mode === 'unlisted-calendar' ? 'more' : '',
          });
        expect(args).toMatchObject({
          command: ['events'],
          options: { max: 1, fields: 'items(id),nextPageToken' },
        });
        if (mode === 'denied') return { ok: false };
        return ok(
          mode === 'bad-shape'
            ? {}
            : {
                events:
                  (args.arguments as string[])[0] === 'team' && mode === 'changed'
                    ? [{ id: 'event' }]
                    : [],
                nextPageToken: '',
              },
        );
      });
      expect(await probeExistingGoogleTools('calendar', window, read)).toBe(
        mode === 'empty' ? 'unchanged' : mode === 'changed' ? 'changed' : 'unknown',
      );
    },
  );
});
