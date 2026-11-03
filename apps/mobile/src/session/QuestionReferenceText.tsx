import { Fragment, useContext, useState } from 'react';
import { Linking } from 'react-native';
import { Text } from '@/components/AppText';
import { splitQuestionReferences } from '@cindy/maker-shared/interaction';
import { ChatPathChipSpan } from '@/session/ChatPathChipSpan';
import { classifyChatPathLinkTarget } from '@/session/chatPathCandidate';
import { ChatFilePathContext } from '@/session/chatFilePathContext';

/** Inline evidence inherits question typography; only verified links are underlined. */
export function QuestionReferenceText({ text }: { text: string }) {
  const fileContext = useContext(ChatFilePathContext);
  return <>{splitQuestionReferences(text).map((part, index) => {
    if (!part.href) return <Fragment key={index}>{part.text}</Fragment>;
    if (/^https?:\/\//i.test(part.href)) {
      const href = part.href;
      return <Text key={index} accessibilityRole="link" style={{ textDecorationLine: 'underline' }}
        onPress={(event) => {
          event.stopPropagation();
          void Linking.openURL(href).catch(() => undefined);
        }}>
        {part.text}
      </Text>;
    }
    // A new reference or source must read its own verdict in the first frame,
    // before the span's verification effect runs.
    return <ChatPathChipSpan key={JSON.stringify([index, fileContext?.deviceId, fileContext?.workdir, part.href])} candidate={classifyChatPathLinkTarget(part.href)}
      display={part.text} plainStyle={undefined} chipStyle={{ textDecorationLine: 'underline' }} SpanText={Text} usePathState={useState} />;
  })}</>;
}
