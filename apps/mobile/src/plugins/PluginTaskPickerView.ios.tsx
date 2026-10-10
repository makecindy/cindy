import { useEffect, useRef } from "react";
import {
  Button,
  HStack,
  Image,
  ProgressView,
  Text,
  TextField,
  VStack,
  useNativeState,
  type TextFieldRef,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  autocorrectionDisabled,
  background,
  buttonStyle,
  contentShape,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  padding,
  shapes,
  textInputAutocapitalization,
  textFieldStyle,
  submitLabel,
  onSubmit,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { PlatformColor } from "react-native";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { ComposerSheet } from "@/session/ComposerSheet";
import { ComposerNativeRow } from "@/session/ComposerNativeRow";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import type { PluginTaskPickerViewProps } from "./PluginTaskPickerView";

/** Ungrouped native task list inside the shared system sheet. */
export function PluginTaskPickerView(p: PluginTaskPickerViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const query = useNativeState(p.query);
  const input = useRef<TextFieldRef>(null);
  const pending = useRef<{
    id: string;
    owner: ReturnType<typeof getMobileAuthOwner>;
  } | null>(null);
  useEffect(() => {
    if (query.get() !== p.query) query.set(p.query);
  }, [p.query, query]);
  useEffect(() => {
    pending.current = null;
  }, [p.deviceId]);
  const rows = p.rows.filter((row) =>
    row.title.toLocaleLowerCase().includes(p.query.toLocaleLowerCase()),
  );
  return (
    <ComposerSheet
      visible={p.visible}
      title={t("plugins.chooseTask")}
      nativeContent
      nativeList
      testID="plugins.taskPicker"
      onClose={() => {
        pending.current = null;
        p.onClose();
      }}
      onClosed={() => {
        const selected = pending.current;
        pending.current = null;
        if (selected && isMobileAuthOwnerCurrent(selected.owner))
          p.onSelect(selected.id);
      }}
      nativeHeader={
        <VStack
          modifiers={[
            fixedSize({ horizontal: false, vertical: true }),
            padding({
              horizontal: spacing.lg + spacing.xs,
              bottom: spacing.sm,
            }),
          ]}
        >
          <HStack
            spacing={spacing.sm}
            modifiers={[
              padding({ horizontal: spacing.md }),
              frame({ height: 44 }),
              background(
                PlatformColor("tertiarySystemFill"),
                shapes.roundedRectangle({ cornerRadius: radius.control }),
              ),
            ]}
          >
            <Image
              systemName="magnifyingglass"
              size={iconSize.md}
              modifiers={[foregroundStyle(colors.textSecondary)]}
            />
            <TextField
              ref={input}
              text={query}
              placeholder={t("plugins.searchTasks")}
              onTextChange={p.onChangeQuery}
              testID="plugins.taskSearch"
              modifiers={[
                frame({ maxWidth: Infinity, minHeight: 44 }),
                textFieldStyle("plain"),
                font({ textStyle: "body" }),
                foregroundStyle(colors.textPrimary),
                submitLabel("search"),
                onSubmit(() => void input.current?.blur()),
                autocorrectionDisabled(true),
                textInputAutocapitalization("never"),
                accessibilityLabel(t("plugins.searchTasks")),
              ]}
            >
              <TextField.Placeholder>
                <Text modifiers={[foregroundStyle(colors.textPlaceholder)]}>
                  {t("plugins.searchTasks")}
                </Text>
              </TextField.Placeholder>
            </TextField>
            {p.query ? (
              <Button
                onPress={() => {
                  query.set("");
                  p.onChangeQuery("");
                }}
                testID="plugins.clearTaskSearch"
                modifiers={[
                  buttonStyle("plain"),
                  accessibilityLabel(t("plugins.clearTaskSearch")),
                  frame({ width: 44, height: 44 }),
                  contentShape(shapes.rectangle()),
                ]}
              >
                <Image
                  systemName="xmark.circle.fill"
                  size={iconSize.md}
                  modifiers={[foregroundStyle(colors.textSecondary)]}
                />
              </Button>
            ) : null}
          </HStack>
        </VStack>
      }
    >
      {p.loading ? (
        <ProgressView
          testID="plugins.tasksLoading"
          modifiers={[listRowBackground("clear"), listRowSeparator("hidden")]}
        />
      ) : p.error ? (
        <>
          <Text modifiers={[foregroundStyle(colors.textSecondary)]}>
            {t("plugins.loadFailed")}
          </Text>
          <ComposerNativeRow
            title={t("plugins.retry")}
            onPress={p.onRetry}
            testID="plugins.retryTasks"
          />
        </>
      ) : rows.length ? (
        rows.map((row) => (
          <VStack
            key={row.id}
            modifiers={[
              listRowBackground("clear"),
              listRowInsets({
                leading: spacing.lg + spacing.xs,
                trailing: spacing.lg + spacing.xs,
                top: spacing.md,
                bottom: spacing.md,
              }),
            ]}
          >
            <ComposerNativeRow
              title={row.title}
              subtitle={row.preview || undefined}
              subtitleContent={
                row.preview ? (
                  <Text
                    modifiers={[
                      font({ textStyle: "caption" }),
                      foregroundStyle(colors.textSecondary),
                      lineLimit(2),
                    ]}
                  >
                    {row.preview}
                  </Text>
                ) : undefined
              }
              onPress={() => {
                if (!p.visible || p.loading || p.error || pending.current)
                  return;
                pending.current = { id: row.id, owner: getMobileAuthOwner() };
                p.onClose();
              }}
              testID={"plugins.task." + row.id}
            />
          </VStack>
        ))
      ) : (
        <Text
          modifiers={[
            foregroundStyle(colors.textSecondary),
            listRowBackground("clear"),
            listRowSeparator("hidden"),
          ]}
          testID="plugins.noTasks"
        >
          {t(p.rows.length ? "plugins.noMatchingTasks" : "plugins.noTasks")}
        </Text>
      )}
    </ComposerSheet>
  );
}
