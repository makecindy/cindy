import type { ComponentProps } from 'react';
import { ChatMessageHoverActions, ChatMessageReactions } from '../ChatServerControls';
import { ChatReactionButton } from '../ChatReactionButton';
import { useChatReactions, type ChatReactionReads } from '../useChatReactions';

type Props = Omit<ComponentProps<typeof ChatMessageHoverActions>, 'controls'> & {
  onChanged: (id: string) => void;
  reactionReads?: ChatReactionReads;
  details?: boolean;
};

export function GroupReactionFixture({ onChanged, reactionReads, details, ...props }: Props) {
  const controls = useChatReactions(props.groupId, props.message, onChanged, reactionReads);
  return <>
    {details ? controls.reactions.map(reaction =>
      <ChatReactionButton key={reaction.emoji} groupId={props.groupId} messageId={props.message.id}
        reaction={reaction} revision={props.reactionRevision} members={props.members} disabled={!props.groupId}
        optimistic={!props.message.reactions?.includes(reaction)} onToggle={() => void controls.toggle(reaction.emoji)} />
    ) : <ChatMessageReactions {...props} controls={controls} />}
    <ChatMessageHoverActions {...props} controls={controls} />
  </>;
}
