import { describe, expect, it } from 'vitest';

import {
  AGENT_MESSAGE_REFERENCE_MAX_CHARS,
  projectAgentFacingText,
  projectPersistedAgentFacingUserText,
  readAgentInputReferences,
  type AgentInputReference,
} from '../agentInputProjection.js';

const QUOTE_MARKER = '> <!-- cindy-composer-quote -->';

function rangeFor<T extends Omit<AgentInputReference, 'start' | 'end'>>(
  text: string,
  href: string,
  reference: T,
): T & { start: number; end: number } {
  const start = text.indexOf(href);
  if (start < 0) throw new Error(`missing href in fixture: ${href}`);
  return { ...reference, start, end: start + href.length };
}

describe('agent-facing Composer projection', () => {
  it('removes exact quote marker lines only when quotesEncoded is true without mutating input', () => {
    const text = `${QUOTE_MARKER}\n> selected\n\nreply`;
    const source = { text, quotesEncoded: true };

    expect(projectAgentFacingText(source)).toBe('> selected\n\nreply');
    expect(source).toEqual({ text, quotesEncoded: true });
    expect(projectAgentFacingText({ text, quotesEncoded: false })).toBe(text);
    expect(projectAgentFacingText({ text })).toBe(text);
  });

  it('projects message, conversation and project chips in source order', () => {
    const messageHref = 'cindy://session/session-a?message=message-a';
    const sessionHref = 'cindy://session/session-b';
    const projectHref = 'cindy://project/%2Frepos%2Fcindy';
    const text = `Read ${messageHref}, continue [Planning](${sessionHref}), then open ${projectHref}.`;
    const message = rangeFor(text, messageHref, {
      kind: 'message' as const,
      href: messageHref,
      sessionId: 'stale-session',
      messageClientId: 'stale-message',
      text: 'Full target message body',
    });
    const sessionStart = text.indexOf('[Planning]');
    const sessionEnd = text.indexOf(')', sessionStart) + 1;
    const references: AgentInputReference[] = [
      message,
      {
        kind: 'session',
        start: sessionStart,
        end: sessionEnd,
        href: sessionHref,
        sessionId: 'stale-session',
        title: 'Planning',
      },
      rangeFor(text, projectHref, {
        kind: 'project' as const,
        href: projectHref,
        name: 'Cindy',
        workingDir: '/stale/path',
      }),
    ];

    const projected = projectAgentFacingText({ text, agentReferences: references });

    expect(projected.indexOf('[Referenced message]'))
      .toBeLessThan(projected.indexOf('[Referenced conversation]'));
    expect(projected.indexOf('[Referenced conversation]'))
      .toBeLessThan(projected.indexOf('[Referenced project]'));
    expect(projected).toContain('Session ID: session-a');
    expect(projected).toContain('Message ID: message-a');
    expect(projected).toContain('Full target message body');
    expect(projected).toContain('Title: Planning');
    expect(projected).toContain('Session ID: session-b');
    expect(projected).toContain('Name: Cindy');
    expect(projected).toContain('Working directory: /repos/cindy');
    expect(projected).not.toContain(messageHref);
    expect(projected).not.toContain(sessionHref);
    expect(projected).not.toContain(projectHref);
  });

  it('ignores stale spans and overlapping duplicate metadata', () => {
    const href = 'cindy://session/session-a';
    const text = `prefix ${href} suffix`;
    const start = text.indexOf(href);
    const valid: AgentInputReference = {
      kind: 'session',
      start,
      end: start + href.length,
      href,
      sessionId: 'session-a',
      title: 'Valid',
    };
    const stale: AgentInputReference = {
      ...valid,
      start: 0,
    };
    const duplicate: AgentInputReference = {
      ...valid,
      title: 'Duplicate',
    };

    expect(readAgentInputReferences([stale], text)).toEqual([]);
    expect(readAgentInputReferences([valid, duplicate], text)).toEqual([valid]);
    expect(projectAgentFacingText({ text, agentReferences: [stale] })).toBe(text);
  });

  it('bounds referenced message content and marks truncation explicitly', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const body = 'x'.repeat(AGENT_MESSAGE_REFERENCE_MAX_CHARS + 10);
    const reference = rangeFor(href, href, {
      kind: 'message' as const,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: body,
    });

    const projected = projectAgentFacingText({ text: href, agentReferences: [reference] });

    expect(projected).toContain('x'.repeat(AGENT_MESSAGE_REFERENCE_MAX_CHARS));
    expect(projected).not.toContain('x'.repeat(AGENT_MESSAGE_REFERENCE_MAX_CHARS + 1));
    expect(projected).toContain('[Content truncated]');
  });

  it('strips long trailing slash runs from untrusted session and project links', () => {
    const slashes = '/'.repeat(50_000);
    const messageHref = `cindy://session/session-a${slashes}?message=message-a`;
    const projectHref = `cindy://project/%2Frepos%2Fcindy${slashes}`;
    const text = `${messageHref} ${projectHref}`;
    const references: AgentInputReference[] = [
      rangeFor(text, messageHref, {
        kind: 'message' as const,
        href: messageHref,
        sessionId: 'stale-session',
        messageClientId: 'stale-message',
        text: 'Target body',
      }),
      rangeFor(text, projectHref, {
        kind: 'project' as const,
        href: projectHref,
        name: 'Cindy',
        workingDir: '/stale/path',
      }),
    ];

    const projected = projectAgentFacingText({ text, agentReferences: references });
    expect(projected).toContain('Session ID: session-a');
    expect(projected).toContain('Message ID: message-a');
    expect(projected).toContain('Working directory: /repos/cindy');
  });

  it('projects persisted envelopes while preserving hand-written markers without the flag', () => {
    const text = `${QUOTE_MARKER}\n> selected`;
    expect(projectPersistedAgentFacingUserText(JSON.stringify({
      text,
      quotesEncoded: true,
    }))).toBe('> selected');
    expect(projectPersistedAgentFacingUserText({
      text,
      quotesEncoded: false,
    })).toBe(text);
  });
});
