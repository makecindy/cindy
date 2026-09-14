import { describe, expect, it } from 'vitest';

import {
  parseRemoteActionInvokeRequest,
  parseRemoteCollectionListRequest,
  parseRemoteResourceChangedPayload,
  parseRemoteResourceClientDescriptor,
  parseRemoteResourceGetRequest,
  resolveRemoteText,
} from '../remoteResources.js';

const client = {
  protocolVersion: 1,
  primitives: ['markdown', 'action', 'markdown'],
  locale: 'zh-CN',
};

describe('remote resource request parsing', () => {
  it('normalizes additive client capabilities without closing future primitive names', () => {
    expect(parseRemoteResourceClientDescriptor(client)).toEqual({
      protocolVersion: 1,
      primitives: ['markdown', 'action'],
      locale: 'zh-CN',
    });
    expect(parseRemoteResourceClientDescriptor({
      protocolVersion: 2,
      primitives: ['future.timeline-object.v7'],
      ignoredByOlderHost: true,
    })).toEqual({
      protocolVersion: 2,
      primitives: ['future.timeline-object.v7'],
    });
  });

  it('bounds collection reads while ignoring additive request fields', () => {
    expect(parseRemoteCollectionListRequest({
      client,
      collectionId: 'teammates',
      limit: 50,
      query: 'design',
      futureOption: { anything: true },
    })).toEqual({
      client: {
        protocolVersion: 1,
        primitives: ['markdown', 'action'],
        locale: 'zh-CN',
      },
      collectionId: 'teammates',
      limit: 50,
      query: 'design',
    });
    expect(parseRemoteCollectionListRequest({ client, collectionId: 'teammates', limit: 201 }))
      .toBeNull();
  });

  it('requires a fully scoped resource reference', () => {
    expect(parseRemoteResourceGetRequest({
      client,
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
    })).toMatchObject({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
    });
    expect(parseRemoteResourceGetRequest({ client, ref: { kind: 'bot', id: 'bot-1' } }))
      .toBeNull();
  });

  it('validates generic invalidation payload scope', () => {
    expect(parseRemoteResourceChangedPayload({
      collectionId: 'teammates',
      resourceRefs: [{ collectionId: 'teammates', kind: 'bot', id: 'bot-1' }],
      revision: '42',
      futureField: true,
    })).toEqual({
      collectionId: 'teammates',
      resourceRefs: [{ collectionId: 'teammates', kind: 'bot', id: 'bot-1' }],
      revision: '42',
    });
    expect(parseRemoteResourceChangedPayload({
      collectionId: 'teammates',
      resourceRefs: [{ collectionId: 'other', kind: 'bot', id: 'bot-1' }],
    })).toBeNull();
  });

  it('accepts bounded generic action input and rejects oversized payloads', () => {
    expect(parseRemoteActionInvokeRequest({
      client,
      collectionId: 'teammates',
      actionId: 'future-action',
      input: { answer: 'yes' },
      additiveField: true,
    })).toMatchObject({
      collectionId: 'teammates',
      actionId: 'future-action',
      input: { answer: 'yes' },
    });
    expect(parseRemoteActionInvokeRequest({
      client,
      collectionId: 'teammates',
      actionId: 'future-action',
      input: { huge: 'x'.repeat(70_000) },
    })).toBeNull();
  });
});

describe('resolveRemoteText', () => {
  const text = {
    fallback: 'Teammates',
    translations: { zh: '伙伴', 'zh-TW': '夥伴' },
  };

  it('uses exact locale, then language, then host fallback', () => {
    expect(resolveRemoteText(text, 'zh-TW')).toBe('夥伴');
    expect(resolveRemoteText(text, 'zh-CN')).toBe('伙伴');
    expect(resolveRemoteText(text, 'fr-FR')).toBe('Teammates');
    expect(resolveRemoteText('Already rendered', 'zh-CN')).toBe('Already rendered');
  });
});
