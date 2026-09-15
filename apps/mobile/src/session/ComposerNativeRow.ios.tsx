import { iconSize } from '@/theme';
import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ComposerNativeRowProps } from "./ComposerNativeRow";
export function ComposerNativeRow({
  title,
  subtitle,
  selected,
  onPress,
  onOptions,
  optionsLabel,
  disabled: unavailable,
  testID,
}: ComposerNativeRowProps) {
  return (
    <HStack spacing={0}>
      <Button
        onPress={onPress}
        testID={testID}
        modifiers={[
          accessibilityAddTraits(selected ? ["isSelected"] : []),
          buttonStyle("plain"),
          disabled(!!unavailable),
          frame({ maxWidth: Infinity }),
          accessibilityLabel([title, subtitle].filter(Boolean).join(", ")),
        ]}
      >
        <HStack
          modifiers={[
            frame({ maxWidth: Infinity, minHeight: 44 }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <VStack alignment="leading" spacing={3}>
            <Text modifiers={[font({ textStyle: "body" })]}>{title}</Text>
            {subtitle ? (
              <Text
                modifiers={[
                  font({ textStyle: "caption" }),
                  foregroundStyle({ type: "hierarchical", style: "secondary" }),
                ]}
              >
                {subtitle}
              </Text>
            ) : null}
          </VStack>
          <Spacer />
          {selected ? <Image size={iconSize.lg} systemName="checkmark" /> : null}
        </HStack>
      </Button>
      {onOptions ? (
        <Button onPress={onOptions} testID={`${testID}.optionsButton`}
          modifiers={[buttonStyle("borderless"), disabled(!!unavailable), accessibilityLabel(optionsLabel ?? title)]}>
          <Image size={iconSize.lg} systemName="slider.horizontal.3" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
        </Button>
      ) : null}
    </HStack>
  );
}
