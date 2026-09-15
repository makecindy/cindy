import { iconSize } from "@/theme";
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
  leading,
  accessory,
  optionsIcon,
  selectionIcon,
  title,
  titleAccessory,
  subtitleContent,
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
          {leading}
          <VStack alignment="leading" spacing={3}>
            <HStack spacing={6}>
              <Text modifiers={[font({ textStyle: "body" })]}>{title}</Text>
              {titleAccessory}
            </HStack>
            {subtitleContent ??
              (subtitle ? (
                <Text
                  modifiers={[
                    font({ textStyle: "caption" }),
                    foregroundStyle({
                      type: "hierarchical",
                      style: "secondary",
                    }),
                  ]}
                >
                  {subtitle}
                </Text>
              ) : null)}
          </VStack>
          <Spacer />
          {accessory}
          {selected
            ? (selectionIcon ?? (
                <Image size={iconSize.lg} systemName="checkmark" />
              ))
            : null}
        </HStack>
      </Button>
      {onOptions ? (
        <Button
          onPress={onOptions}
          testID={`${testID}.optionsButton`}
          modifiers={[
            buttonStyle("borderless"),
            disabled(!!unavailable),
            accessibilityLabel(optionsLabel ?? title),
          ]}
        >
          <HStack
            modifiers={[
              frame({ width: 44, height: 44 }),
              contentShape(shapes.rectangle()),
            ]}
          >
            {optionsIcon ?? (
              <Image size={iconSize.lg} systemName="slider.horizontal.3" />
            )}
          </HStack>
        </Button>
      ) : null}
    </HStack>
  );
}
