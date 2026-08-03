import {
  Globe2,
  Monitor,
  Plug,
} from 'lucide-react';

import type { AgentInputReference } from '../../../shared/agentInputQueue';
import { InlineReferenceChip } from './InlineReferenceChip';
import { ProjectLinkChip } from './ProjectLinkChip';
import { SessionLinkChip } from './SessionLinkChip';

const MESSAGE_REFERENCE_LABEL_MAX = 240;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The compact label shared by the rich chip and collapsed-message projection. */
export function sentAgentReferenceDisplayLabel(reference: AgentInputReference): string {
  if (reference.kind === 'message') {
    const text = oneLine(reference.text ?? '') || reference.messageClientId;
    return text.length <= MESSAGE_REFERENCE_LABEL_MAX
      ? text
      : `${text.slice(0, MESSAGE_REFERENCE_LABEL_MAX - 1)}…`;
  }
  if (reference.kind === 'session') return oneLine(reference.title ?? '') || reference.sessionId;
  if (reference.kind === 'project') return oneLine(reference.name) || reference.workingDir;
  if (reference.kind === 'browser-tab') return oneLine(reference.title ?? '') || reference.url;
  if (reference.kind === 'desktop-window') {
    return oneLine(reference.title ?? '') || oneLine(reference.appName);
  }
  return oneLine(reference.label) || reference.resourceId;
}

/** Render one persisted Composer reference with the same visual shell as the input chip. */
export function SentAgentReferenceChip({ reference }: { reference: AgentInputReference }) {
  if (reference.kind === 'message') {
    return (
      <SessionLinkChip
        href={reference.href}
        {...(reference.text?.trim() ? { label: reference.text } : {})}
      />
    );
  }
  if (reference.kind === 'session') {
    return (
      <SessionLinkChip
        href={reference.href}
        {...(reference.title?.trim() ? { label: reference.title } : {})}
      />
    );
  }
  if (reference.kind === 'project') {
    return <ProjectLinkChip href={reference.href} label={reference.name} />;
  }

  const label = sentAgentReferenceDisplayLabel(reference);
  const icon = reference.kind === 'browser-tab'
    ? <Globe2 aria-hidden />
    : reference.kind === 'desktop-window'
      ? <Monitor aria-hidden />
      : <Plug aria-hidden />;

  return (
    <InlineReferenceChip
      label={label}
      icon={icon}
      tooltip={label}
      ariaLabel={label}
      className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
    />
  );
}
