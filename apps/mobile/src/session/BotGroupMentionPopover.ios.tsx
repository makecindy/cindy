import { Host } from '@expo/ui';
import { useState } from 'react';
import { HStack, Popover, RNHostView, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, frame, padding } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';
import type { BotGroupMentionPopoverProps } from './BotGroupMentionPopover';
import { BOT_GROUP_MENTION_AVATAR_SIZE } from './BotGroupAvatars';

/** A real native popover, including compact-width iPhone presentation. */
export function BotGroupMentionPopover({ position, width, onClose, avatar, name, displayName, caption }: BotGroupMentionPopoverProps) {
  const { mode, colors } = useTheme();
  // Mount the anchor before presentation; presenting during native onAppear
  // uses a detached hosting controller on the first tap.
  const [ready, setReady] = useState(false);
  return <Host colorScheme={mode} seedColor={colors.textPrimary} onLayout={() => setReady(true)}
    style={{ position: 'absolute', left: position.x, top: position.y, width: 1, height: 1 }}>
    <Popover isPresented={ready} attachmentAnchor="center" onIsPresentedChange={open => { if (!open) onClose(); }}>
      <Popover.Trigger><VStack modifiers={[frame({ width: 1, height: 1 })]}>{null}</VStack></Popover.Trigger>
      <Popover.Content>
        <HStack spacing={spacing.lg} modifiers={[padding({ all: spacing.lg }), frame({ width })]} testID="botGroup.mention.identity">
          <RNHostView matchContents><View style={{ width: BOT_GROUP_MENTION_AVATAR_SIZE, height: BOT_GROUP_MENTION_AVATAR_SIZE }}>{avatar}</View></RNHostView>
          <VStack alignment="leading" spacing={spacing.xs} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
            <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(colors.textPrimary)]}>{name}</Text>
            {displayName ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{displayName}</Text> : null}
            {caption ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{caption}</Text> : null}
          </VStack>
        </HStack>
      </Popover.Content>
    </Popover>
  </Host>;
}
