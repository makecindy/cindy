import { describe, expect, it } from 'vitest';
import { resolveComposerModelSelection } from '../composerModelSelection';
import type { SessionRuntimeProfileProjection } from '@/lib/ccAgent.types';

const current: SessionRuntimeProfileProjection = { agentKind: 'codex', model: 'codex/gpt-5.6-sol', providerId: 'xd', effort: 'high', fastMode: true };
const next: SessionRuntimeProfileProjection = { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: null, fastMode: false };

describe('composer model selection projection', () => {
  it('shows same-Harness pending configuration while retaining the current route', () => {
    expect(resolveComposerModelSelection({ current, pending: { generation: 2, source: 'agent', profile: next } })).toEqual({ current, display: next, pending: true });
  });
  it('switches every axis together when a cross-Harness intent takes precedence', () => {
    const intent = { target: 'pi' as const, model: 'gpt-6', providerId: null, effort: null, fastMode: false };
    expect(resolveComposerModelSelection({ current, pending: { generation: 2, source: 'agent', profile: next }, intent }).display).toEqual({ agentKind: 'pi', model: 'gpt-6', providerId: null, effort: null, fastMode: false });
  });
  it('returns to the authoritative current profile after cancellation, and advances after settlement', () => {
    expect(resolveComposerModelSelection({ current, pending: null })).toEqual({ current, display: current, pending: false });
    expect(resolveComposerModelSelection({ current, effective: next, pending: null })).toEqual({ current: next, display: next, pending: false });
  });
  it('shows the newest remote choice ahead of an older pending echo', () => {
    const latest = { ...next, model: 'newest', providerId: 'another', fastMode: true };
    expect(resolveComposerModelSelection({ current, pending: { generation: 2, source: 'agent', profile: next }, optimistic: latest }).display).toEqual(latest);
  });
  it('keeps remote Fast and provider in the same optimistic snapshot', () => {
    expect(resolveComposerModelSelection({ current, optimistic: next })).toEqual({ current, display: next, pending: true });
  });
});
