import { describe, expect, it, vi } from 'vitest';

import type {
  GhostManifest,
  GhostSetupAllowedAction,
  GhostSetupAssessment,
} from '../../../shared/ghost';
import { GHOST_SECRET_VALUE_MAX_CHARS } from '../../../shared/ghost';
import { executeGhostSetupInlineSubmission } from '../ghostSetupInlineExecutor';

const action: Extract<GhostSetupAllowedAction, { kind: 'inline_form' }> = {
  id: 'inline_form:opaque',
  kind: 'inline_form',
  form: {
    fields: [
      {
        id: 'value',
        type: 'secret',
        label: 'API Key',
        required: true,
        maxLength: 4096,
      },
    ],
  },
};

function manifest(source?: 'user' | 'oauth' | 'login-email' | 'oidc-token'): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool', 'network'],
    tools: [{ name: 'call', description: 'Call' }],
    network: {
      hosts: ['api.example.com'],
      secrets: [
        {
          key: 'api_key',
          label: 'API Key',
          ...(source ? { source } : {}),
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          ...(source === 'oauth'
            ? {
                oauth: {
                  authorizeUrl: 'https://api.example.com/auth',
                  tokenUrl: 'https://api.example.com/token',
                },
              }
            : {}),
        },
      ],
    },
  };
}

function assessment(
  actionId = action.id,
  ref = 'secret:api_key',
  label = 'API Key',
): GhostSetupAssessment {
  return {
    state: 'required',
    revision: 3,
    groups: [
      {
        id: 'credential',
        mode: 'any_of',
        items: [
          {
            ref,
            kind: 'secret',
            label,
            state: 'missing',
            actions: [{ ...action, id: actionId }],
          },
        ],
      },
    ],
  };
}

describe('executeGhostSetupInlineSubmission', () => {
  it('revalidates the fresh assessment and stores only its bound user Secret', () => {
    const storeSecret = vi.fn(() => true);
    const emitChange = vi.fn();
    const result = executeGhostSetupInlineSubmission(
      {
        getAssessment: () => assessment(),
        getManifest: () => manifest(),
        storeSecret,
        emitChange,
      },
      { ghostId: 'demo', action, value: '  actual-value  ' },
    );

    expect(result).toEqual({ ok: true });
    expect(storeSecret).toHaveBeenCalledWith('demo', 'api_key', 'actual-value');
    expect(emitChange).toHaveBeenCalledWith('demo', 'api_key');
  });

  it('stores an assessment-bound node Secret through the same Host vault path', () => {
    const storeSecret = vi.fn(() => true);
    const emitChange = vi.fn();
    const nodeManifest: GhostManifest = {
      ...manifest(),
      settingsHtml: 'settings.html',
      slots: ['tool', 'network', 'node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_code',
            label: 'Mail code',
            methods: ['mail/action'],
          },
        ],
      },
    };

    const result = executeGhostSetupInlineSubmission(
      {
        getAssessment: () => assessment(action.id, 'secret:mail_code', 'Mail code'),
        getManifest: () => nodeManifest,
        storeSecret,
        emitChange,
      },
      { ghostId: 'demo', action, value: '  node-secret  ' },
    );

    expect(result).toEqual({ ok: true });
    expect(storeSecret).toHaveBeenCalledWith('demo', 'mail_code', 'node-secret');
    expect(emitChange).toHaveBeenCalledWith('demo', 'mail_code');
  });

  it('rejects forged/stale actions and non-user Secret declarations without writing', () => {
    for (const fixture of [
      { current: assessment('inline_form:different'), currentManifest: manifest() },
      { current: assessment(), currentManifest: manifest('oauth') },
      { current: assessment(), currentManifest: manifest('login-email') },
      { current: assessment(), currentManifest: manifest('oidc-token') },
    ]) {
      const storeSecret = vi.fn(() => true);
      const result = executeGhostSetupInlineSubmission(
        {
          getAssessment: () => fixture.current,
          getManifest: () => fixture.currentManifest,
          storeSecret,
          emitChange: vi.fn(),
        },
        { ghostId: 'demo', action, value: 'must-not-be-written' },
      );
      expect(result.ok).toBe(false);
      expect(storeSecret).not.toHaveBeenCalled();
    }
  });

  it('keeps a committed write successful when the best-effort notice throws', () => {
    const logger = { warn: vi.fn() };
    const secret = 'notice-sensitive-value';
    const result = executeGhostSetupInlineSubmission(
      {
        getAssessment: () => assessment(),
        getManifest: () => manifest('user'),
        storeSecret: () => true,
        emitChange: vi.fn(),
        onSaved: () => {
          throw new Error('renderer unavailable');
        },
        logger,
      },
      { ghostId: 'demo', action, value: secret },
    );

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
  });

  it('rejects empty and oversized values before any storage lookup', () => {
    const getAssessment = vi.fn(() => assessment());
    for (const value of [' ', 'x'.repeat(4097)]) {
      expect(
        executeGhostSetupInlineSubmission(
          {
            getAssessment,
            getManifest: () => manifest(),
            storeSecret: vi.fn(() => true),
            emitChange: vi.fn(),
          },
          { ghostId: 'demo', action, value },
        ).ok,
      ).toBe(false);
    }
    expect(getAssessment).not.toHaveBeenCalled();
  });

  it('applies the Secret length limit to the trimmed value that is stored', () => {
    const storeSecret = vi.fn(() => true);
    const value = `  ${'x'.repeat(GHOST_SECRET_VALUE_MAX_CHARS)}  `;

    expect(
      executeGhostSetupInlineSubmission(
        {
          getAssessment: () => assessment(),
          getManifest: () => manifest(),
          storeSecret,
          emitChange: vi.fn(),
        },
        { ghostId: 'demo', action, value },
      ),
    ).toEqual({ ok: true });
    expect(storeSecret).toHaveBeenCalledWith(
      'demo',
      'api_key',
      'x'.repeat(GHOST_SECRET_VALUE_MAX_CHARS),
    );
  });
});
