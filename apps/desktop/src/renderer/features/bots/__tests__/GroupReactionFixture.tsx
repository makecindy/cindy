import type { ComponentProps } from 'react';
import { ChatMessageHoverActions, ChatMessageReactions } from '../ChatServerControls';
import { useChatReactions, type ChatReactionReads } from '../useChatReactions';

type Props = Omit<ComponentProps<typeof ChatMessageHoverActions>, 'controls'> & {
  onChanged: (id: string) => void;
  reactionReads?: ChatReactionReads;
};

export function GroupReactionFixture({ onChanged, reactionReads, ...props }: Props) {
  const controls = useChatReactions(props.groupId, props.message, onChanged, reactionReads);
  return <>
    <ChatMessageReactions {...props} controls={controls} />
    <ChatMessageHoverActions {...props} controls={controls} />
  </>;
}
