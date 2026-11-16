import { useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { ChevronDown, Pencil, Copy, Check, Monitor } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import {
  PROJECT_ALIASES_GET_CHANNEL,
  isProjectImage,
  isProjectImageDraft,
  PROJECT_EMOJIS,
  PROJECT_SYMBOLS,
  PROJECT_ICON_COLORS,
  parseProjectSymbol,
  parseProjectLetters,
  projectLettersValue,
  projectSymbolValue,
  type ProjectIconColor,
  PROJECT_SETTINGS_SET_CHANNEL,
  projectDirectoryName,
  defaultProjectLetters,
  defaultProjectColor,
  resolveProjectIcon,
  validProjectIcon,
} from "@cindy/maker-shared/project-alias-sync";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { Text, TextInput } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowOptionButton,
} from "@/components/MobilePrimitives";
import { useTheme, radius, spacing, typeScale, lineHeight, fontWeight, iconSize } from "@/theme";
import { FormSheet } from "./FormSheet";
import {
  useRemoteProjectAliases,
  refreshRemoteProjectAliases,
} from "./remoteProjectAliases";
import {
  ProjectIcon,
  projectIconColor,
  useAutomaticProjectIcon,
} from "./ProjectIcon";

export function ProjectSettingsSheet({
  deviceId,
  deviceName,
  projectKey,
  title,
  directory,
  visible,
  onClose,
}: {
  deviceId: string;
  deviceName?: string | null;
  projectKey: string;
  title: string;
  directory: string;
  visible: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`settings.projectInfo.${key}`);
  const { colors } = useTheme();
  const colorLabel = (color: ProjectIconColor) =>
    color === "default" ? label("colors.default") : t(`taskTags.${color}`);
  const chooseColor = (color: ProjectIconColor) => {
    setPickerColor(color);
    setColorOpen(false);
    if (mode === "letters") {
      if (validProjectIcon(`text:${letters}`))
        setPickerIcon(letterValue(letters, color));
    } else {
      setPickerIcon(
        projectSymbolValue(
          parseProjectSymbol(pickerIcon)?.name ?? "Folder",
          color,
        ),
      );
    }
  };
  const { invoke } = useDeviceLink();
  const snapshot = useRemoteProjectAliases().get(deviceId);
  const automatic = useAutomaticProjectIcon(
    projectKey,
    deviceId,
    (snapshot?.settingsVersion ?? 0) >= 4,
  );
  const defaultName = projectDirectoryName(directory);
  const [name, setName] = useState(title);
  const [editingName, setEditingName] = useState(false);
  const [icon, setIcon] = useState<string | null>(null);
  const [initial, setInitial] = useState<{
    name: string;
    icon: string | null;
  } | null>(null);
  useEffect(() => {
    if (snapshot && !initial) {
      const value = resolveProjectIcon(snapshot, projectKey);
      setInitial({ name: title, icon: value });
      setIcon(value);
    }
  }, [snapshot, initial, title, projectKey]);
  const [stage, setStage] = useState<"profile" | "icon">("profile");
  const [mode, setMode] = useState<"symbols" | "emoji" | "letters" | "image">(
    "symbols",
  );
  const [pickerIcon, setPickerIcon] = useState<string | null>(null);
  const [pickerColor, setPickerColor] = useState<ProjectIconColor>("default");
  const letterValue = (text: string, color = pickerColor) =>
    projectLettersValue(
      text,
      (snapshot?.settingsVersion ?? 0) >= 5 ? color : "default",
    );
  const [colorOpen, setColorOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const [letters, setLetters] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [owner] = useState(getMobileAuthOwner);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = !!initial && (snapshot?.settingsVersion ?? 0) >= 2;
  const dirty =
    !!initial && (name.trim() !== initial.name || icon !== initial.icon);
  const disabled = busy || imageBusy || !available;
  const close = () => {
    if (busy || imageBusy) return;
    Keyboard.dismiss();
    if (stage === "icon") {
      setStage("profile");
      setError(null);
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert(label("discardHint"), undefined, [
      { text: label("keepEditing"), style: "cancel" },
      { text: label("discard"), style: "destructive", onPress: onClose },
    ]);
  };
  const save = async () => {
    if (
      lock.current ||
      !available ||
      !dirty ||
      !snapshot?.ownerStamp ||
      !isMobileAuthOwnerCurrent(owner)
    )
      return;
    Keyboard.dismiss();
    lock.current = true;
    setBusy(true);
    setError(null);
    const value: { name?: string; icon?: string | null } = {};
    if (name.trim() !== initial!.name)
      value.name = name.trim() === defaultName ? "" : name.trim();
    if (icon !== initial!.icon) value.icon = icon;
    try {
      await invoke(deviceId, PROJECT_SETTINGS_SET_CHANNEL, [
        { projectKey, field: "profile", value, ...snapshot.ownerStamp },
      ]);
      if (!isMobileAuthOwnerCurrent(owner)) return;
      await refreshRemoteProjectAliases(
        deviceId,
        () => invoke(deviceId, PROJECT_ALIASES_GET_CHANNEL, []),
        () => isMobileAuthOwnerCurrent(owner),
        true,
      );
      onClose();
    } catch {
      if (mounted.current) setError(label("failed"));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const upload = async () => {
    if (disabled) return;
    Keyboard.dismiss();
    setImageBusy(true);
    setError(null);
    try {
      const picker = await import("expo-image-picker");
      const result = await picker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (result.canceled || !result.assets[0]) return;
      const { ImageManipulator, SaveFormat } =
        await import("expo-image-manipulator");
      const { File } = await import("expo-file-system");
      const context = ImageManipulator.manipulate(result.assets[0].uri);
      context.resize({ width: 256, height: 256 });
      let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
      try {
        image = await context.renderAsync();
        let saved = await image.saveAsync({
          format: SaveFormat.PNG,
          base64: true,
        });
        try {
          new File(saved.uri).delete();
        } catch {
          /* OS cache cleanup can finish later. */
        }
        let mime = "png";
        if (saved.base64 && saved.base64.length > 299_950) {
          saved = await image.saveAsync({
            format: SaveFormat.JPEG,
            compress: 0.85,
            base64: true,
          });
          mime = "jpeg";
          try {
            new File(saved.uri).delete();
          } catch {
            /* OS cache cleanup can finish later. */
          }
        }
        if (!saved.base64 || saved.base64.length > 299_950)
          throw new Error("Image too large");
        if (mounted.current && isMobileAuthOwnerCurrent(owner)) {
          setPickerIcon(`data:image/${mime};base64,${saved.base64}`);
          setCustomEmoji("");
          setMode("image");
        }
      } finally {
        image?.release();
        context.release();
      }
    } catch (error) {
      if (__DEV__)
        console.warn("[project-icon] Image conversion failed", error);
      if (mounted.current) setError(label("imageError"));
    } finally {
      if (mounted.current) setImageBusy(false);
    }
  };
  const draw = (value: string | null, size: number) => (
    <ProjectIcon
      value={value}
      projectKey={projectKey}
      projectName={name.trim() || defaultName}
      automaticEnabled={(snapshot?.settingsVersion ?? 0) >= 4}
      deviceId={deviceId}
      size={size}
    />
  );
  const textColor = { color: colors.textPrimary };
  const noteColor = { color: colors.textSecondary };
  const inputStyle = [
    styles.input,
    textColor,
    { backgroundColor: colors.surfaceChip },
  ];
  const tileStyle = [styles.preview, { backgroundColor: colors.surfaceChip }];
  const pickerInvalid =
    (mode === "letters" && !!letters && !validProjectIcon(`text:${letters}`)) ||
    (mode === "emoji" &&
      !!customEmoji &&
      (!validProjectIcon(customEmoji) || customEmoji.includes(":")));
  const symbols = PROJECT_SYMBOLS.filter((item) =>
    `${item.name} ${item.keywords}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  return (
    <FormSheet
      visible={visible}
      title={label(stage === "profile" ? "title" : "chooseIcon")}
      onClose={close}
      preventDismiss={busy || imageBusy || dirty || stage === "icon"}
      leadingAction={{
        label: label("cancel"),
        onPress: close,
        disabled: busy || imageBusy,
      }}
      trailingAction={{
        label: label(stage === "icon" ? "applyIcon" : "save"),
        busy: busy || imageBusy,
        disabled: disabled || (stage === "profile" ? !dirty : pickerInvalid),
        onPress: () => {
          if (stage === "icon") {
            Keyboard.dismiss();
            setIcon(pickerIcon);
            setStage("profile");
            setError(null);
          } else void save();
        },
      }}
    >
      <View style={styles.content}>
        {error || !available ? (
          <Text accessibilityRole="alert" style={[styles.note, noteColor]}>
            {error ?? label("unavailable")}
          </Text>
        ) : null}
        {stage === "profile" ? (
          <>
            <View style={styles.hero}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={label("changeIcon")}
                disabled={disabled}
                onPress={() => {
                  Keyboard.dismiss();
                  setEditingName(false);
                  setPickerIcon(icon);
                  setPickerColor(
                    (snapshot?.settingsVersion ?? 0) >= 3
                      ? (parseProjectSymbol(icon)?.color ??
                          parseProjectLetters(icon)?.color ??
                          defaultProjectColor(name.trim() || defaultName))
                      : "default",
                  );
                  setMode(
                    isProjectImage(icon) || isProjectImageDraft(icon)
                      ? "image"
                      : icon?.startsWith("text:")
                        ? "letters"
                        : icon && !icon.includes(":")
                          ? "emoji"
                          : "symbols",
                  );
                  setLetters(parseProjectLetters(icon)?.text ?? "");
                  setCustomEmoji("");
                  setColorOpen(false);
                  setQuery("");
                  setError(null);
                  setStage("icon");
                }}
              >
                <View style={tileStyle}>
                  {draw(
                    icon,
                    isProjectImage(icon) || isProjectImageDraft(icon) ? 72 : 40,
                  )}
                  <View
                    style={[
                      styles.editBadge,
                      { backgroundColor: colors.surfaceChip },
                    ]}
                  >
                    <Pencil size={iconSize.sm} color={colors.textSecondary} />
                  </View>
                </View>
              </Pressable>
              <View style={styles.grow}>
                {editingName ? (
                  <TextInput
                    accessibilityLabel={label("name")}
                    value={name}
                    onChangeText={setName}
                    maxLength={80}
                    editable={!disabled}
                    placeholder={defaultName}
                    placeholderTextColor={colors.textPlaceholder}
                    autoFocus
                    selectTextOnFocus
                    returnKeyType="done"
                    onBlur={() => setEditingName(false)}
                    onSubmitEditing={() => {
                      Keyboard.dismiss();
                      setEditingName(false);
                    }}
                    style={[
                      styles.nameInput,
                      styles.title,
                      textColor,
                      { borderColor: colors.border },
                    ]}
                  />
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={label("name")}
                    disabled={disabled}
                    onPress={() => setEditingName(true)}
                    style={styles.nameButton}
                  >
                    <Text
                      numberOfLines={2}
                      style={[styles.title, textColor, { flexShrink: 1 }]}
                    >
                      {name.trim() || defaultName}
                    </Text>
                    <Pencil size={iconSize.sm} color={colors.textSecondary} />
                  </Pressable>
                )}
                {name !== defaultName && (
                  <Pressable
                    disabled={disabled}
                    onPress={() => setName(defaultName)}
                    accessibilityRole="button"
                    style={[styles.reset, { alignSelf: "flex-start" }]}
                  >
                    <Text style={[styles.note, noteColor]}>
                      {label("reset")}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
            <Text style={[styles.note, noteColor]}>{label("nameHint")}</Text>
            {(snapshot?.settingsVersion ?? 0) >= 4 &&
              (icon === null || automatic.result?.candidate) && (
                <View style={{ gap: spacing.sm }}>
                  {icon === null && (
                    <Text style={[styles.note, noteColor]}>
                      {automatic.loading
                        ? label("autoLoading")
                        : automatic.result?.image && !automatic.result.candidate
                          ? `${label("autoSource")}: ${automatic.result.source}`
                          : label("autoNone")}
                    </Text>
                  )}
                  {automatic.result?.candidate && automatic.result.image && (
                    <Pressable
                      accessibilityRole="button"
                      disabled={disabled}
                      onPress={() => setIcon(automatic.result!.image)}
                      style={styles.colorRow}
                    >
                      {draw(automatic.result.image, 32)}
                      <Text style={[styles.path, textColor]}>
                        {label("githubAvatar")}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            <View style={styles.location}>
              <View style={styles.computer}>
                <Monitor size={iconSize.md} color={colors.textSecondary} />
                <Text style={[styles.note, noteColor]}>
                  {deviceName || label("thisComputer")}
                </Text>
              </View>
              <View style={styles.directoryRow}>
                <View style={styles.grow}>
                  <Text style={[styles.note, noteColor]}>
                    {label("directory")}
                  </Text>
                  <Text selectable style={[styles.path, textColor]}>
                    {directory}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={label(copied ? "copied" : "copy")}
                  style={styles.copy}
                  onPress={() =>
                    void Clipboard.setStringAsync(directory)
                      .then(() => setCopied(true))
                      .catch(() => setError(label("failed")))
                  }
                >
                  {copied ? (
                    <Check size={iconSize.lg} color={colors.textSecondary} />
                  ) : (
                    <Copy size={iconSize.lg} color={colors.textSecondary} />
                  )}
                </Pressable>
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.pickerHero}>
              <View style={[tileStyle, styles.pickerPreview]}>
                {draw(
                  pickerIcon,
                  isProjectImage(pickerIcon) || isProjectImageDraft(pickerIcon)
                    ? 48
                    : 28,
                )}
              </View>
              <Text
                numberOfLines={1}
                style={[styles.path, styles.grow, textColor]}
              >
                {name.trim() || defaultName}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={pickerIcon === null || disabled}
                onPress={() => {
                  setLetters("");
                  setCustomEmoji("");
                  setPickerIcon(null);
                  setPickerColor("default");
                }}
                style={styles.reset}
              >
                <Text style={[styles.note, noteColor]}>{label("reset")}</Text>
              </Pressable>
            </View>
            <View style={styles.tabs}>
              {(["symbols", "emoji", "letters", "image"] as const).map(
                (item) => (
                  <MainWindowOptionButton
                    key={item}
                    label={label(item)}
                    variant="segmented"
                    density="compact"
                    style={styles.grow}
                    selected={mode === item}
                    onPress={() => {
                      Keyboard.dismiss();
                      setMode(item);
                      if (item === "letters") {
                        const next =
                          letters ||
                          defaultProjectLetters(name.trim() || defaultName);
                        setLetters(next);
                        if (validProjectIcon(`text:${next}`))
                          setPickerIcon(letterValue(next));
                      }
                      setColorOpen(false);
                      setError(null);
                    }}
                  />
                ),
              )}
            </View>
            {((mode === "symbols" && (snapshot?.settingsVersion ?? 0) >= 3) ||
              (mode === "letters" &&
                (snapshot?.settingsVersion ?? 0) >= 5)) && (
              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("taskTags.color")}
                  accessibilityValue={{ text: colorLabel(pickerColor) }}
                  accessibilityState={{ expanded: colorOpen }}
                  disabled={disabled}
                  onPress={() => {
                    Keyboard.dismiss();
                    setColorOpen(!colorOpen);
                  }}
                  style={styles.colorRow}
                >
                  <Text style={[styles.note, noteColor]}>
                    {t("taskTags.color")}
                  </Text>
                  <View style={[styles.colorValue, styles.grow]}>
                    <View
                      style={[
                        styles.colorSwatch,
                        {
                          borderWidth: 1,
                          borderColor: colors.border,
                          backgroundColor:
                            pickerColor === "default"
                              ? colors.textPrimary
                              : projectIconColor(colors, pickerColor),
                        },
                      ]}
                    />
                    <Text style={[styles.path, textColor, { flexShrink: 1 }]}>
                      {colorLabel(pickerColor)}
                    </Text>
                    <ChevronDown
                      size={iconSize.md}
                      color={colors.textSecondary}
                      style={{
                        transform: [{ rotate: colorOpen ? "180deg" : "0deg" }],
                      }}
                    />
                  </View>
                </Pressable>
                {colorOpen && (
                  <View style={{ gap: spacing.sm }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={colorLabel("default")}
                      accessibilityState={{
                        selected: pickerColor === "default",
                      }}
                      disabled={disabled}
                      onPress={() => {
                        Keyboard.dismiss();
                        chooseColor("default");
                      }}
                      style={{
                        minHeight: 44,
                        alignSelf: "flex-start",
                        maxWidth: "100%",
                        paddingHorizontal: spacing.sm,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: spacing.sm,
                        borderRadius: radius.pill,
                      }}
                    >
                      <View
                        style={[
                          styles.colorRing,
                          {
                            borderColor:
                              pickerColor === "default"
                                ? colors.textPrimary
                                : "transparent",
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.colorSwatch,
                            { backgroundColor: colors.textPrimary },
                          ]}
                        />
                      </View>
                      <Text style={[styles.path, textColor, { flexShrink: 1 }]}>
                        {colorLabel("default")}
                      </Text>
                      {pickerColor === "default" && (
                        <Check size={iconSize.sm} color={colors.textPrimary} />
                      )}
                    </Pressable>
                    <View
                      style={styles.grid}
                      accessibilityLabel={t("taskTags.color")}
                    >
                      {PROJECT_ICON_COLORS.filter(
                        (color) => color !== "default",
                      ).map((color) => (
                        <View key={color} style={styles.colorCell}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={colorLabel(color)}
                            accessibilityState={{
                              selected: pickerColor === color,
                            }}
                            disabled={disabled}
                            onPress={() => {
                              Keyboard.dismiss();
                              chooseColor(color);
                            }}
                            style={styles.colorTarget}
                          >
                            <View
                              style={[
                                styles.colorRing,
                                {
                                  borderColor:
                                    pickerColor === color
                                      ? colors.textPrimary
                                      : "transparent",
                                },
                              ]}
                            >
                              {
                                <View
                                  style={[
                                    styles.colorSwatch,
                                    {
                                      borderWidth: 1,
                                      borderColor: colors.border,
                                      backgroundColor: projectIconColor(
                                        colors,
                                        color,
                                      ),
                                    },
                                  ]}
                                />
                              }
                            </View>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}
            {mode === "symbols" ? (
              <TextInput
                accessibilityLabel={label("search")}
                placeholder={label("search")}
                placeholderTextColor={colors.textPlaceholder}
                value={query}
                onChangeText={setQuery}
                style={inputStyle}
              />
            ) : null}
            {mode === "emoji" ? (
              <TextInput
                accessibilityLabel={label("customEmoji")}
                placeholder={label("customEmoji")}
                placeholderTextColor={colors.textPlaceholder}
                value={customEmoji}
                maxLength={32}
                onChangeText={(value) => {
                  setCustomEmoji(value);
                  if (validProjectIcon(value) && !value.includes(":"))
                    setPickerIcon(value);
                }}
                style={inputStyle}
              />
            ) : null}
            {mode === "image" && (
              <View style={styles.imagePage}>
                <View style={[tileStyle, styles.imagePreview]}>
                  {draw(
                    pickerIcon,
                    isProjectImage(pickerIcon) ||
                      isProjectImageDraft(pickerIcon)
                      ? 112
                      : 48,
                  )}
                </View>
                <MainWindowActionButton
                  action={{
                    label: label("upload"),
                    onPress: () => void upload(),
                    disabled,
                    tone: "secondary",
                  }}
                />
                <Text style={[styles.note, noteColor, { textAlign: "center" }]}>
                  {label("imageHint")}
                </Text>
              </View>
            )}
            {mode === "letters" ? (
              <>
                <TextInput
                  accessibilityLabel={label("letters")}
                  placeholder="Aa"
                  placeholderTextColor={colors.textPlaceholder}
                  value={letters}
                  maxLength={2}
                  onChangeText={(value) => {
                    setLetters(value);
                    if (validProjectIcon(`text:${value}`))
                      setPickerIcon(letterValue(value));
                  }}
                  style={inputStyle}
                />
                <Text style={[styles.note, noteColor]}>
                  {label("lettersHint")}
                </Text>
              </>
            ) : mode !== "image" ? (
              <View style={styles.grid}>
                {(mode === "symbols"
                  ? symbols.map((item) =>
                      projectSymbolValue(item.name, pickerColor),
                    )
                  : PROJECT_EMOJIS
                ).map((value) => (
                  <View key={value} style={styles.cell}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        parseProjectSymbol(value)?.name ?? value
                      }
                      accessibilityState={{ selected: pickerIcon === value }}
                      disabled={disabled}
                      onPress={() => {
                        setCustomEmoji("");
                        setPickerIcon(value);
                      }}
                      style={[
                        styles.choice,
                        {
                          backgroundColor:
                            pickerIcon === value
                              ? colors.surfaceChip
                              : "transparent",
                          borderColor:
                            pickerIcon === value
                              ? colors.textSecondary
                              : "transparent",
                        },
                      ]}
                    >
                      {draw(value, 24)}
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            {mode === "symbols" && symbols.length === 0 ? (
              <Text style={[styles.note, noteColor]}>{label("noResults")}</Text>
            ) : null}
          </>
        )}
      </View>
    </FormSheet>
  );
}
const styles = StyleSheet.create({
  content: { gap: spacing.lg, paddingBottom: spacing.lg },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingVertical: spacing.lg,
  },
  editBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    padding: spacing.xs,
    borderTopLeftRadius: radius.container,
  },
  nameButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  nameInput: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.container,
  },
  pickerHero: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  pickerPreview: { width: 48, height: 48 },
  reset: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  colorRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  colorValue: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  imagePage: {
    alignItems: "center",
    gap: spacing.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  imagePreview: { width: 112, height: 112 },
  preview: {
    width: 72,
    height: 72,
    borderRadius: radius.container,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1, minWidth: 0, gap: spacing.xs },
  title: {
    fontSize: typeScale.title,
    lineHeight: lineHeight.title,
    fontWeight: fontWeight.semibold,
  },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  path: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  input: {
    width: "100%",
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: typeScale.body,
    borderRadius: radius.container,
  },
  location: { gap: spacing.lg, paddingHorizontal: spacing.sm },
  computer: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  directoryRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  copy: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  colorCell: { width: "16.666666%", alignItems: "center" },
  colorTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  colorRing: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  colorSwatch: { width: 20, height: 20, borderRadius: radius.pill },
  tabs: { flexDirection: "row", gap: spacing.xs },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: "16.666666%",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  choice: {
    width: 44,
    height: 44,
    borderRadius: radius.container,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
