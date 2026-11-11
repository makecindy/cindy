import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, radius, spacing, useTheme } from '@/theme';
import { MOBILE_COMPOSER_CONTROL_SIZE } from './composerVoiceButtonAnchor';
import { NativeErrorNotice } from '@/components/NativeErrorNotice.ios';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { useNativeTextDraft } from './nativeTextDraft';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
} from "react";
import { Button, HStack, Image, Menu, Picker, RNHostView, ProgressView, ScrollView, Spacer, Text, TextField, Toggle, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityHint,
  accessibilityLabel,
  background,
  buttonStyle,
  contentShape,
  disabled as disable,
  font,
  frame,
  foregroundStyle,
  lineLimit,
  listRowInsets,
  listRowSeparator,
  menuIndicator,
  onLongPressGesture,
  onTapGesture,
  padding,
  pickerStyle,
  shapes,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type {
  ContextSheetChipRowProps,
  ContextSheetChoiceRowProps,
  ContextSheetGroupProps,
  ContextSheetSelectRowProps,
  ContextSheetProps,
  ContextSheetRowProps,
  ContextSheetFooterButtonProps,
  ContextSheetTextFieldProps,
  ContextSheetToolbarRowProps,
} from "./ContextSheet";
import { ComposerSheet } from "./ComposerSheet";
import { ComposerSectionSettingsHeader } from './composerSectionHeader';
const DismissAction = createContext<(action: () => void) => void>((action) =>
  action(),
);

export function ContextSheet(props: ContextSheetProps) {
  const { t } = useTranslation();
  const pending = useRef<(() => void) | null>(null);
  const { colors } = useTheme();
  // Reopening during the dismiss animation drops the previous row action, so a later
  // ordinary close cannot replay a stale picker.
  useEffect(() => {
    if (props.visible) pending.current = null;
  }, [props.visible]);
  return (
    <DismissAction.Provider
      value={(action) => {
        pending.current = action;
        props.onClose();
      }}
    >
      <ComposerSectionSettingsHeader.Provider value>
        <ComposerSheet
          {...props}
          title={props.onBack ? props.title : ''}
          aboveContent={props.media}
          aboveContentTitle={t("session.common.groupAdd")}
          nativeContent
          onClosed={() => {
            const action = pending.current;
            pending.current = null;
            action?.();
          }}
          footer={props.footer}
        >
          {props.children}
          {props.error ? (
            <Section>
              <NativeErrorNotice message={props.error} />
            </Section>
          ) : null}
        </ComposerSheet>
      </ComposerSectionSettingsHeader.Provider>
    </DismissAction.Provider>
  );
}
export function ContextSheetGroup({
  label,
  children,
  footer,
  footerTone,
  footerTestID,
}: ContextSheetGroupProps) {
  // 说明写在卡片下方(原生 Section footer)。
  return (
    <Section
      title={label || undefined}
      footer={footer ? <ContextSheetNote text={footer} tone={footerTone} testID={footerTestID} /> : undefined}
    >
      {children}
    </Section>
  );
}
export function ContextSheetRow(props: ContextSheetRowProps) {
  const dismiss = useContext(DismissAction);
  const { colors } = useTheme();
  const labelModifiers = props.destructive ? [foregroundStyle(colors.destructive)] : [];
  const press = () => (props.dismissBeforePress ? dismiss(props.onPress) : props.onPress());
  const inactive = !!props.disabled || !!props.busy;
  const content = (extraModifiers: ReturnType<typeof frame>[]) => (
    <HStack
      modifiers={[
        frame({ maxWidth: Infinity, minHeight: 44 }),
        contentShape(shapes.rectangle()),
        ...extraModifiers,
      ]}
    >
      {props.icon ? (
        <RNHostView matchContents>
          <View style={{ width: 28, height: 28, justifyContent: "center" }}>
            {props.icon}
          </View>
        </RNHostView>
      ) : null}
      {props.detail ? (
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[...labelModifiers, lineLimit(1)]}>{props.label}</Text>
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{props.detail}</Text>
        </VStack>
      ) : (
        <Text modifiers={labelModifiers}>{props.label}</Text>
      )}
      <Spacer />
      {props.value && !props.busy ? (
        <Text modifiers={[foregroundStyle(colors.textSecondary), lineLimit(1)]}>{props.value}</Text>
      ) : null}
      {props.busy ? (
        <ProgressView />
      ) : props.trailing && props.trailing !== "chevron" ? (
        <RNHostView matchContents>
          {/* matchContents reads this RN View's bounds, not the nested icon's size. */}
          <View style={props.trailingSize != null ? {
            width: props.trailingSize,
            height: props.trailingSize,
            alignItems: 'center',
            justifyContent: 'center',
          } : undefined}>{props.trailing}</View>
        </RNHostView>
      ) : props.trailing === "chevron" ? (
        <Image size={iconSize.lg} systemName="chevron.right" color={colors.textTertiary} />
      ) : null}
    </HStack>
  );
  const accessibility = props.accessibilityHint ? [accessibilityHint(props.accessibilityHint)] : [];
  if (props.onLongPress) {
    // 带长按的行(协同 Worker):SwiftUI Button 与长按手势会互相抢,改用同一视图上的
    // 点按 + 长按手势,点按直接执行,长按弹出管理操作。
    const longPress = props.onLongPress;
    return content([
      listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }),
      disable(inactive),
      accessibilityAddTraits(['isButton']),
      ...accessibility,
      ...(inactive ? [] : [onTapGesture(press), onLongPressGesture(longPress)]),
    ]);
  }
  return (
    <Button
      onPress={press}
      testID={props.testID}
      modifiers={[
        buttonStyle("plain"),
        listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }),
        disable(inactive),
        ...accessibility,
      ]}
    >
      {content([])}
    </Button>
  );
}
export function ContextSheetFooterButton(props: ContextSheetFooterButtonProps) {
  const { colors } = useTheme();
  const glassStyle = useNativeGlassButtonStyle({ prominent: true });
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      modifiers={[
        ...glassStyle,
        disable(!!props.disabled || !!props.busy),
      ]}
    >
      {/* 撑满宽度的 frame 放在标签里:放在 Button 上只会放大点击区,胶囊仍按文字收缩。 */}
      {props.busy
        ? <ProgressView modifiers={[tint(colors.ctaText), frame({ maxWidth: Infinity, minHeight: 44 })]} />
        : <Text modifiers={[foregroundStyle(colors.ctaText), frame({ maxWidth: Infinity, minHeight: 44 })]}>{props.label}</Text>}
    </Button>
  );
}

export function ContextSheetNote({ text, tone = 'secondary', testID }: {
  text: string;
  tone?: 'secondary' | 'error';
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Text testID={testID} modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(tone === 'error' ? colors.errorText : colors.textSecondary)]}>
      {text}
    </Text>
  );
}

/** 由现有 Section 提供独立操作失败的卡片容器。 */
export function ContextSheetError({ text, testID }: { text: string; testID?: string }) {
  return <NativeErrorNotice message={text} testID={testID} />;
}

export function ContextSheetChoiceRow<T extends string>(props: ContextSheetChoiceRowProps<T>) {
  return (
    <Picker
      label={props.label}
      selection={props.value ?? ''}
      onSelectionChange={(next: string | number) => {
        const option = props.options.find((item) => item.id === String(next));
        if (option) props.onChange(option.id);
      }}
      modifiers={[pickerStyle(props.options.length <= 3 ? 'segmented' : 'menu'), disable(!!props.disabled)]}
      testID={props.testID}
    >
      {props.options.map((option) => (
        <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>
      ))}
    </Picker>
  );
}

export function ContextSheetSelectRow(props: ContextSheetSelectRowProps) {
  return (
    <Picker
      label={props.label}
      selection={props.value}
      onSelectionChange={(next: string | number) => {
        if (!props.disabled && props.options.some((option) => option.id === String(next) && !option.disabled)) {
          props.onChange(String(next));
        }
      }}
      modifiers={[pickerStyle('menu'), disable(!!props.disabled)]}
      testID={props.testID}
    >
      {props.options.map((option) => (
        <Text key={option.id} modifiers={[tag(option.id), disable(!!option.disabled)]}>
          {option.detail ? `${option.label} · ${option.detail}` : option.label}
        </Text>
      ))}
    </Picker>
  );
}

const CHIP_HEIGHT = 32;
/** 系统表单行里文字距卡片左右边的距离：自绘的标签排和工具行按它对齐上下的文字。 */
const FORM_ROW_TEXT_INSET = 20;

/** 一排可点的小标签(角色等)，末尾可带加号。排不下时横向滑动；长按用于移除这类管理操作。 */
export function ContextSheetChipRow(props: ContextSheetChipRowProps) {
  const { colors } = useTheme();
  // 可见的胶囊 32pt，外面再撑到 44pt 作为点按范围。
  const chip = (selected: boolean) => [
    frame({ height: CHIP_HEIGHT }),
    background(selected ? colors.cta : colors.surfaceChip, shapes.capsule()),
    frame({ minHeight: 44 }),
    contentShape(shapes.rectangle()),
    disable(!!props.disabled),
  ];
  return (
    <ScrollView
      axes="horizontal"
      showsIndicators={false}
      testID={props.testID}
      modifiers={[
        listRowInsets({ top: 0, bottom: 0, leading: FORM_ROW_TEXT_INSET, trailing: FORM_ROW_TEXT_INSET }),
        accessibilityLabel(props.label),
      ]}
    >
      <HStack spacing={spacing.sm}>
        {props.chips.map((item) => {
          const selected = item.id === props.value;
          const longPress = props.onLongPress;
          return (
            <Text
              key={item.id}
              testID={props.testID ? `${props.testID}.${item.id}` : undefined}
              modifiers={[
                font({ textStyle: 'subheadline', weight: 'medium' }),
                foregroundStyle(selected ? colors.ctaText : colors.textPrimary),
                lineLimit(1),
                padding({ horizontal: spacing.md }),
                ...chip(selected),
                accessibilityAddTraits(selected ? ['isButton', 'isSelected'] : ['isButton']),
                ...(longPress && props.longPressHint ? [accessibilityHint(props.longPressHint)] : []),
                // 点按要排在长按前面：只挂长按会拦住这一排的横向滑动。
                ...(props.disabled ? [] : [
                  onTapGesture(() => props.onChange(item.id)),
                  ...(longPress ? [onLongPressGesture(() => longPress(item.id))] : []),
                ]),
              ]}
            >
              {item.label}
            </Text>
          );
        })}
        {props.add ? (
          <Image
            systemName="plus"
            size={iconSize.md}
            color={props.add.selected ? colors.ctaText : colors.textPrimary}
            testID={props.testID ? `${props.testID}.add` : undefined}
            modifiers={[
              frame({ width: CHIP_HEIGHT }),
              ...chip(props.add.selected),
              accessibilityLabel(props.add.label),
              accessibilityAddTraits(props.add.selected ? ['isButton', 'isSelected'] : ['isButton']),
              ...(props.disabled ? [] : [onTapGesture(props.add.onPress)]),
            ]}
          />
        ) : null}
      </HStack>
    </ScrollView>
  );
}

/**
 * 输入框里底部的一行工具：与聊天输入框同序、同形 —— 左边是只有图标的圆钮(权限，点开菜单)，
 * 右边是带文字的胶囊(模型)。底色用面板里标签的同一档，和上面的角色标签是一家。
 */
function ContextSheetToolbarRow({ menu, action, disabled }: ContextSheetToolbarRowProps) {
  const dismiss = useContext(DismissAction);
  const { colors } = useTheme();
  const press = () => (action.dismissBeforePress ? dismiss(action.onPress) : action.onPress());
  return (
    // 与上面的输入框连成一块：这一侧也不画分隔线。
    <HStack
      spacing={spacing.sm}
      modifiers={[
        listRowInsets({ top: 0, bottom: 0, leading: FORM_ROW_TEXT_INSET, trailing: FORM_ROW_TEXT_INSET }),
        listRowSeparator('hidden', 'top'),
      ]}
    >
      {menu ? (
        <Menu
          testID={menu.testID}
          label={
            <RNHostView matchContents>
              {/* 标签里只放图标圆钮：点按与弹出由 Menu 负责。可见的圆 34pt，点按范围撑到 44pt 高。 */}
              <View
                pointerEvents="none"
                accessibilityElementsHidden
                collapsable={false}
                style={{ width: MOBILE_COMPOSER_CONTROL_SIZE, height: 44, justifyContent: 'center' }}
              >
                <View
                  style={{
                    width: MOBILE_COMPOSER_CONTROL_SIZE,
                    height: MOBILE_COMPOSER_CONTROL_SIZE,
                    borderRadius: radius.pill,
                    backgroundColor: colors.surfaceChip,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {menu.icon}
                </View>
              </View>
            </RNHostView>
          }
          modifiers={[
            menuIndicator('hidden'),
            disable(!!disabled),
            accessibilityLabel(menu.accessibilityLabel),
          ]}
        >
          {menu.options.map((option) => (
            // 原生 Toggle 在菜单里画勾；取值仍以表单为准。
            <Toggle
              key={option.id}
              isOn={option.id === menu.value}
              onIsOnChange={() => menu.onChange(option.id)}
              testID={menu.testID ? `${menu.testID}.${option.id}` : undefined}
            >
              <Text>{option.label}</Text>
            </Toggle>
          ))}
        </Menu>
      ) : null}
      <Spacer />
      <Button
        onPress={press}
        testID={action.testID}
        modifiers={[
          buttonStyle('plain'),
          disable(!!disabled),
          accessibilityLabel(action.accessibilityLabel),
        ]}
      >
        <HStack
          spacing={spacing.xs}
          modifiers={[
            padding({ horizontal: spacing.md }),
            frame({ height: MOBILE_COMPOSER_CONTROL_SIZE }),
            background(colors.surfaceChip, shapes.capsule()),
            frame({ minHeight: 44 }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Text modifiers={[font({ textStyle: 'footnote', weight: 'medium' }), foregroundStyle(colors.textPrimary), lineLimit(1)]}>
            {action.label}
          </Text>
          <Image systemName="chevron.down" size={iconSize.xs} color={colors.textTertiary} />
        </HStack>
      </Button>
    </HStack>
  );
}

export function ContextSheetTextField(props: ContextSheetTextFieldProps) {
  const draft = useNativeTextDraft(props.value, props.onChange);
  const toolbar = props.toolbar;
  const field = (
    <TextField
      text={draft.text}
      onTextChange={draft.onTextChange}
      axis={props.multiline ? 'vertical' : 'horizontal'}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      autoFocus={props.autoFocus}
      testID={props.testID}
      modifiers={[
        disable(!!props.disabled),
        accessibilityLabel(props.accessibilityLabel),
        ...(props.multiline ? [lineLimit({ min: 3, max: 6 })] : []),
        // 和下面的工具行连成一块：不画两行之间的分隔线。
        ...(toolbar ? [listRowSeparator('hidden', 'bottom')] : []),
      ]}
    />
  );
  if (!toolbar) return field;
  return (
    <>
      {field}
      <ContextSheetToolbarRow {...toolbar} disabled={toolbar.disabled ?? props.disabled} />
    </>
  );
}
