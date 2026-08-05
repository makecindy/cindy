import { describe, expect, it, vi } from 'vitest';

import { runSchemaStartupPolicy } from '../schemaStartupPolicy';

describe('runSchemaStartupPolicy', () => {
  it('checks compatibility first and performs no schema writes for shared passive', async () => {
    const events: string[] = [];
    const result = await runSchemaStartupPolicy({
      sharedPassive: true,
      checkCompatibility: () => {
        events.push('check');
        return { compatible: true, marker: 'exact' };
      },
      prepareRuntimeManifest: vi.fn(() => {
        events.push('prepare');
      }),
      runMigrations: vi.fn(async () => {
        events.push('migrate');
      }),
      handleSchemaDrift: vi.fn(async () => {
        events.push('drift');
      }),
      cleanupSchemaDdl: vi.fn(() => {
        events.push('ddl');
      }),
    });

    expect(result).toEqual({
      ready: true,
      compatibility: { compatible: true, marker: 'exact' },
    });
    expect(events).toEqual(['check']);
  });

  it('stops before any schema write when passive compatibility fails', async () => {
    const migrate = vi.fn(async () => undefined);
    const drift = vi.fn(async () => undefined);
    const ddl = vi.fn();
    const prepare = vi.fn();
    const result = await runSchemaStartupPolicy({
      sharedPassive: true,
      checkCompatibility: () => ({ compatible: false, marker: 'mismatch' }),
      prepareRuntimeManifest: prepare,
      runMigrations: migrate,
      handleSchemaDrift: drift,
      cleanupSchemaDdl: ddl,
    });

    expect(result.ready).toBe(false);
    expect(migrate).not.toHaveBeenCalled();
    expect(drift).not.toHaveBeenCalled();
    expect(ddl).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares identity intent before primary schema maintenance', async () => {
    const events: string[] = [];
    const result = await runSchemaStartupPolicy({
      sharedPassive: false,
      checkCompatibility: vi.fn(() => ({ compatible: false })),
      prepareRuntimeManifest: () => {
        events.push('prepare');
      },
      runMigrations: async () => {
        events.push('migrate');
      },
      handleSchemaDrift: async () => {
        events.push('drift');
      },
      cleanupSchemaDdl: () => {
        events.push('ddl');
      },
    });

    expect(result).toEqual({ ready: true, compatibility: null });
    expect(events).toEqual(['prepare', 'migrate', 'drift', 'ddl']);
  });
});
