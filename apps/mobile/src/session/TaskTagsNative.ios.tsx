import { useEffect } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Circle,
  Group,
  HStack,
  Image,
  List,
  ProgressView,
  Section as NativeSection,
  Text,
  TextField,
  VStack,
  ZStack,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  moveDisabled,
  opacity,
  shapes,
  strokeBorder,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useNativeGlassButtonStyle } from '@/platform/chrome/nativeGlassButtonStyle.ios';
import { iconSize, useTheme } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { ComposerNativeRow } from './ComposerNativeRow';
import type { TaskTagsExpandedState } from './TaskTags';
import type { NativeTagSwatchProps } from './TaskTagsNative';
import { TAG_SWATCH, taskTagMoveTarget } from './taskTagsNativePage';

/** One drawn swatch for every tag surface; the outline only rescues white tags. */
export function NativeTagSwatch({ color, checkColor, outlined, selected, size }: NativeTagSwatchProps) {
  const { colors } = useTheme();
  const check = size >= TAG_SWATCH.picker ? iconSize.sm : iconSize.xs;
  return (
    <ZStack>
      <Circle
        modifiers={[
          foregroundStyle(color),
          frame({ width: size, height: size }),
          ...(outlined
            ? [strokeBorder({ color: colors.border, shape: 'circle', style: { lineWidth: 1 } })]
            : []),
        ]}
      />
      {selected ? (
        <Image
          systemName="checkmark"
          size={check}
          color={checkColor}
          modifiers={[font({ weight: 'semibold', size: check })]}
        />
      ) : null}
    </ZStack>
  );
}

function Note({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>
      {text}
    </Text>
  );
}

function NameField({
  value,
  label,
  locked,
  onChange,
}: {
  value: string;
  label: string;
  locked: boolean;
  onChange(value: string): void;
}) {
  const { colors } = useTheme();
  // Native owns the text while typing; the form page remounts this for each edit.
  const text = useNativeState(value);
  return (
    <TextField
      text={text}
      onTextChange={onChange}
      maxLength={80}
      autoFocus
      placeholder={label}
      testID="taskTags.form.name"
      modifiers={[tint(colors.inputCaret), disabled(locked), accessibilityLabel(label)]}
    />
  );
}

/** Two even rows; each swatch keeps a full 44pt target. */
function ColorGrid({ form }: { form: TaskTagsExpandedState['form'] }) {
  const rows = [form.colors.slice(0, 6), form.colors.slice(6)];
  return (
    <VStack spacing={0} modifiers={[listRowInsets({ top: 4, bottom: 4, leading: 8, trailing: 8 })]}>
      {rows.map((row, index) => (
        <HStack key={index} spacing={0}>
          {row.map((item) => (
            <Button
              key={item.value}
              onPress={() => form.onColor(item.value)}
              testID={`taskTags.form.color.${item.value}`}
              modifiers={[
                buttonStyle('plain'),
                frame({ maxWidth: Infinity }),
                disabled(form.locked || !item.available),
                accessibilityLabel(item.name),
                accessibilityAddTraits(item.selected ? ['isSelected'] : []),
              ]}
            >
              <ZStack
                modifiers={[
                  frame({ maxWidth: Infinity, height: 48 }),
                  contentShape(shapes.rectangle()),
                  opacity(item.available ? 1 : 0.3),
                ]}
              >
                <NativeTagSwatch {...item} size={TAG_SWATCH.picker} />
              </ZStack>
            </Button>
          ))}
        </HStack>
      ))}
    </VStack>
  );
}

function Status({ state }: { state: TaskTagsExpandedState }) {
  const { t } = useTranslation();
  if (!state.message && !state.canRetry) return null;
  return (
    <Section footer={state.message ? <Note text={state.message} /> : undefined}>
      {state.canRetry ? (
        <ComposerNativeRow
          title={t('taskTags.retry')}
          onPress={state.onRetry}
          testID="taskTags.retry"
        />
      ) : null}
    </Section>
  );
}

function DestructiveRow({
  label,
  locked,
  onPress,
  testID,
}: {
  label: string;
  locked: boolean;
  onPress(): void;
  testID: string;
}) {
  const { colors } = useTheme();
  return (
    <Button
      role="destructive"
      onPress={onPress}
      testID={testID}
      modifiers={[buttonStyle('plain'), disabled(locked)]}
    >
      <Text
        modifiers={[
          foregroundStyle(colors.destructive),
          frame({ maxWidth: Infinity, minHeight: 44, alignment: 'leading' }),
          contentShape(shapes.rectangle()),
        ]}
      >
        {label}
      </Text>
    </Button>
  );
}

function TagForm({ state }: { state: TaskTagsExpandedState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const prominent = useNativeGlassButtonStyle({ prominent: true });
  const { form } = state;
  return (
    <>
      <Section title={t('taskTags.name')}>
        <NameField
          value={form.name}
          label={t('taskTags.name')}
          locked={form.locked}
          onChange={form.onNameChange}
        />
      </Section>
      <Section title={t('taskTags.color')} footer={<Note text={form.hint} />}>
        <ColorGrid form={form} />
      </Section>
      <Status state={state} />
      <NativeSection
        modifiers={[
          listRowBackground('clear'),
          listRowSeparator('hidden'),
          listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
        ]}
      >
        <Button
          onPress={form.onSubmit}
          testID="taskTags.form.submit"
          modifiers={[...prominent, disabled(!form.canSubmit), accessibilityLabel(form.submitLabel)]}
        >
          <VStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}>
            {state.disabled && !state.message ? (
              <ProgressView modifiers={[tint(colors.ctaText)]} />
            ) : (
              <Text modifiers={[foregroundStyle(colors.ctaText)]}>{form.submitLabel}</Text>
            )}
          </VStack>
        </Button>
      </NativeSection>
      {form.canDelete ? (
        <Section>
          <DestructiveRow
            label={t('taskTags.delete')}
            locked={state.disabled}
            onPress={form.onDelete}
            testID="taskTags.form.delete"
          />
        </Section>
      ) : null}
    </>
  );
}

/** SwiftUI rendering of the expanded tag pages: list, add / edit, delete confirmation. */
export function NativeTaskTagsExpanded({ state }: { state: TaskTagsExpandedState }) {
  const { t } = useTranslation();
  // The failure text arrives asynchronously and focus does not move to it, so a footer
  // alone is silent in VoiceOver; the React Native panel exposed it as an alert.
  useEffect(() => {
    if (state.message) AccessibilityInfo.announceForAccessibility(state.message);
  }, [state.message]);
  if (state.page === 'delete' && state.deletion) {
    return (
      <>
        <Section footer={<Note text={state.deletion.message} />}>
          <DestructiveRow
            label={t('taskTags.delete')}
            locked={state.disabled}
            onPress={state.deletion.onConfirm}
            testID="taskTags.delete.confirm"
          />
        </Section>
        <Status state={state} />
      </>
    );
  }
  if (state.page === 'add' || state.page === 'edit') return <TagForm state={state} />;
  return (
    <>
      {state.loading ? (
        <Section>
          <ProgressView />
        </Section>
      ) : state.tags.length ? (
        <Section footer={<Note text={t('taskTags.reorderFooter')} />}>
          <List.ForEach
            onMove={(sources, destination) => {
              const from = sources[0];
              if (from === undefined) return;
              state.onMove(from, taskTagMoveTarget(from, destination));
            }}
          >
            {state.tags.map((tag) => (
              <Group key={tag.id} modifiers={[moveDisabled(state.disabled)]}>
                <ComposerNativeRow
                  leading={<NativeTagSwatch {...tag} selected={false} size={TAG_SWATCH.row} />}
                  title={tag.name}
                  selected={tag.selected}
                  disabled={state.disabled}
                  onPress={() => state.onToggle(tag.id)}
                  onOptions={() => state.onEdit(tag.id)}
                  optionsIcon={<Image size={iconSize.lg} systemName="pencil" />}
                  optionsLabel={t('taskTags.editLabel', { name: tag.name })}
                  testID={`taskTags.tag.${tag.id}`}
                />
              </Group>
            ))}
          </List.ForEach>
        </Section>
      ) : !state.message ? (
        <Section>
          <Note text={t('taskTags.empty')} />
        </Section>
      ) : null}
      {state.canAdd ? (
        <Section>
          <ComposerNativeRow
            leading={<Image size={iconSize.lg} systemName="plus" />}
            title={t('taskTags.add')}
            disabled={state.disabled}
            onPress={state.onAdd}
            testID="taskTags.add"
          />
        </Section>
      ) : null}
      <Status state={state} />
    </>
  );
}
