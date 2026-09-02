import { describe, expect, it } from 'vitest';

import {
  buildSkillhubPublishParams,
  deptMirrorTeamSlug,
  matchesDeptMirrorTeamSlug,
  validateRequiredCategory,
  validateVisibilityScope,
  type PublishFormValues,
} from '../publishForm';

describe('deptMirrorTeamSlug', () => {
  it('uses the Feishu open department id as the materialized team slug', () => {
    expect(deptMirrorTeamSlug('od-platform')).toBe('od-platform');
  });

  it('recognizes a pre-migration mirror slug only while reading old ownership', () => {
    expect(matchesDeptMirrorTeamSlug('od-platform', 'dept-od-platform', 'dept')).toBe(true);
    expect(matchesDeptMirrorTeamSlug('od-platform', 'dept-od-platform', 'xdt-maker')).toBe(true);
    expect(matchesDeptMirrorTeamSlug('od-platform', 'dept-od-platform', null)).toBe(false);
    expect(matchesDeptMirrorTeamSlug('od-platform', 'platform')).toBe(false);
  });
});

const baseForm: PublishFormValues = {
  name: 'sivi-boss-fighting',
  version: '1.2.4',
  displayName: 'Boss fighting',
  summary: 'Helps structure boss fight encounters.',
  description: 'Helps structure boss fight encounters.',
  visibility: 'DEPARTMENT_SCOPED',
  publisherMode: 'team',
  ownerTeamSlug: 'od-dept-owner',
  visibleDeptIds: ['od-dept-1'],
  sharedTeamSlugs: ['combat-team'],
  changelog: 'Add tuning checklist.',
  categoryMode: 'manual',
  categorySlug: 'engine',
};

describe('validateRequiredCategory', () => {
  it('blocks publishing while Hub categories are still loading', () => {
    expect(validateRequiredCategory({
      loading: true,
      error: null,
      categories: [],
      categoryMode: 'manual',
      selectedSlug: '',
    })).toEqual({ ok: false, reason: 'loading' });
  });

  it('allows auto category without loading Hub category options', () => {
    expect(validateRequiredCategory({
      loading: true,
      error: null,
      categories: [],
      categoryMode: 'auto',
      selectedSlug: '',
    })).toEqual({ ok: true });
  });

  it('blocks publishing when Hub categories fail to load or are empty', () => {
    expect(validateRequiredCategory({
      loading: false,
      error: 'network failed',
      categories: [],
      categoryMode: 'manual',
      selectedSlug: '',
    })).toEqual({ ok: false, reason: 'load-error' });

    expect(validateRequiredCategory({
      loading: false,
      error: null,
      categories: [],
      categoryMode: 'manual',
      selectedSlug: '',
    })).toEqual({ ok: false, reason: 'empty' });
  });

  it('requires the selected category to exist in the Hub category list', () => {
    const categories = [{ slug: 'engine', name: 'Engine' }];

    expect(validateRequiredCategory({
      loading: false,
      error: null,
      categories,
      categoryMode: 'manual',
      selectedSlug: '',
    })).toEqual({ ok: false, reason: 'required' });

    expect(validateRequiredCategory({
      loading: false,
      error: null,
      categories,
      categoryMode: 'manual',
      selectedSlug: 'writing',
    })).toEqual({ ok: false, reason: 'invalid' });

    expect(validateRequiredCategory({
      loading: false,
      error: null,
      categories,
      categoryMode: 'manual',
      selectedSlug: 'engine',
    })).toEqual({ ok: true });
  });
});

describe('validateVisibilityScope', () => {
  it('requires a publishing team when publisher mode is team', () => {
    expect(validateVisibilityScope({ ...baseForm, ownerTeamSlug: '' }))
      .toEqual({ ok: false, reason: 'publisher-team-required' });
    expect(validateVisibilityScope({ ...baseForm, visibility: 'PUBLIC', ownerTeamSlug: '' }))
      .toEqual({ ok: false, reason: 'publisher-team-required' });
  });

  it('requires at least one audience for team visibility with personal publisher', () => {
    expect(validateVisibilityScope({
      ...baseForm,
      publisherMode: 'personal',
      visibleDeptIds: [],
      sharedTeamSlugs: [],
    })).toEqual({ ok: false, reason: 'audience-required' });

    expect(validateVisibilityScope({
      ...baseForm,
      visibleDeptIds: [],
      sharedTeamSlugs: [],
    })).toEqual({ ok: true });

    expect(validateVisibilityScope({
      ...baseForm,
      visibility: 'PUBLIC',
      publisherMode: 'personal',
      visibleDeptIds: [],
      sharedTeamSlugs: [],
    })).toEqual({ ok: true });
  });
});

describe('buildSkillhubPublishParams', () => {
  it('includes selected Hub metadata when publishing a skill for the first time', () => {
    expect(buildSkillhubPublishParams({
      form: baseForm,
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
      categories: [{ slug: 'engine', name: 'Game Engine' }],
    })).toMatchObject({
      absolutePath: '/tmp/sivi-boss-fighting',
      name: 'sivi-boss-fighting',
      isFirstPublish: true,
      version: '1.2.4',
      displayName: 'Boss fighting',
      summary: 'Helps structure boss fight encounters.',
      description: 'Helps structure boss fight encounters.',
      tags: ['Game Engine'],
      visibility: 'DEPARTMENT_SCOPED',
      deptTeamSlug: 'od-dept-owner',
      visibleSlugs: ['od-dept-1', 'combat-team'],
    });
  });

  it('forces personal ownership and empty audience for private publishes', () => {
    const params = buildSkillhubPublishParams({
      form: { ...baseForm, visibility: 'PRIVATE' },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
    });

    expect(params.visibility).toBe('PRIVATE');
    expect(params.visibleSlugs).toEqual([]);
    expect(params.teamSlug).toBeUndefined();
    expect(params.deptTeamSlug).toBeUndefined();
  });

  it('uses the no-tag option without sending a misleading auto-classification mode', () => {
    expect(buildSkillhubPublishParams({
      form: { ...baseForm, categoryMode: 'auto' },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
    })).toMatchObject({
      tags: [],
      deptTeamSlug: 'od-dept-owner',
      visibleSlugs: ['od-dept-1', 'combat-team'],
    });
  });

  it('maps a regular team publisher to teamSlug instead of deptTeamSlug', () => {
    const params = buildSkillhubPublishParams({
      form: { ...baseForm, ownerTeamSlug: 'combat-team', sharedTeamSlugs: [] },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
    });

    expect(params).toMatchObject({ teamSlug: 'combat-team' });
    expect(params).not.toHaveProperty('deptTeamSlug');
  });

  it('omits legacy owner selectors when ownership comes from the authenticated membership', () => {
    const params = buildSkillhubPublishParams({
      form: baseForm,
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
      ownerType: 'organization',
    });

    expect(params).not.toHaveProperty('deptTeamSlug');
    expect(params).not.toHaveProperty('teamSlug');
    expect(params).toMatchObject({
      visibility: 'DEPARTMENT_SCOPED',
      visibleSlugs: [],
    });
  });

  it('sends team publisher for public visibility and omits visibleSlugs', () => {
    expect(buildSkillhubPublishParams({
      form: { ...baseForm, visibility: 'PUBLIC' },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
    })).toMatchObject({
      visibility: 'PUBLIC',
      deptTeamSlug: 'od-dept-owner',
      visibleSlugs: [],
    });
  });

  it('omits owner fields for personal publisher', () => {
    const params = buildSkillhubPublishParams({
      form: { ...baseForm, publisherMode: 'personal' },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: true,
    });

    expect(params).not.toHaveProperty('deptTeamSlug');
    expect(params).not.toHaveProperty('teamSlug');
    expect(params).toMatchObject({ visibleSlugs: ['od-dept-1', 'combat-team'] });
  });

  it('omits category metadata when publishing a new version', () => {
    const params = buildSkillhubPublishParams({
      form: { ...baseForm, categorySlug: 'writing' },
      publishAbsolutePath: '/tmp/sivi-boss-fighting',
      submitName: 'sivi-boss-fighting',
      isFirstPublish: false,
    });

    expect(params).toMatchObject({
      absolutePath: '/tmp/sivi-boss-fighting',
      name: 'sivi-boss-fighting',
      isFirstPublish: false,
      version: '1.2.4',
      summary: 'Helps structure boss fight encounters.',
      description: 'Helps structure boss fight encounters.',
      changelog: 'Add tuning checklist.',
    });
    expect(params).not.toHaveProperty('categoryMode');
    expect(params).not.toHaveProperty('categories');
    expect(params).not.toHaveProperty('visibility');
    expect(params).not.toHaveProperty('visibleSlugs');
  });
});
