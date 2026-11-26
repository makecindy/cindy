import {
  isExplicitProjectRepositoryAddress,
  parseProjectRepository,
  projectCreationFolderName,
} from "@cindy/maker-shared/project-alias-sync";
import { createMobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { useOrcaWorkerDirectoryPicker } from "./useOrcaWorkerDirectoryPicker";
import { OrcaWorkerDirectoryPicker } from "./OrcaWorkerDirectoryPicker";
import { ProjectDirectoriesEditor } from "./ProjectDirectoriesEditor";
import {
  resolveProjectDirectories,
  type ProjectDirectory,
} from "@cindy/maker-shared/project-alias-sync";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { ChevronDown, Pencil, Check, Monitor } from "lucide-react-native";
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
  projectAliasComparisonKey,
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
import {
  useTheme,
  radius,
  spacing,
  typeScale,
  lineHeight,
  fontWeight,
  iconSize,
} from "@/theme";
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
  projectKey: existingKey,
  title,
  directory: initialDirectory,
  create = false,
  onCreated,
  visible,
  onClose,
}: {
  create?: boolean;
  onCreated?(directory: string): void;
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
  const [directory, setDirectory] = useState(initialDirectory);
  const projectKey = create ? `local:${directory}` : existingKey;
  const snapshot = useRemoteProjectAliases().get(deviceId);
  const automatic = useAutomaticProjectIcon(
    projectKey,
    deviceId,
    !create && !!directory && (snapshot?.settingsVersion ?? 0) >= 4,
  );
  const defaultName = projectDirectoryName(directory);
  const [name, setName] = useState(title);
  const nameEdited = useRef(!!title.trim());
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [source, setSource] = useState<"local" | "repository">("local");
  const repositoryExpanded = source === "repository";
  const chooseSource = (next: "local" | "repository") => {
    if (next === source) return;
    setSource(next);
    setRepositoryUrl("");
    setDirectory("");
    setDirectories([]);
    setError(null);
  };
  const repositoryCreation = create && (snapshot?.settingsVersion ?? 0) >= 7;
  const automaticDirectory = repositoryCreation && !directory;
  const directoryPreview = automaticDirectory
    ? `${snapshot?.creationRoot ?? ""}/${projectCreationFolderName(name || parseProjectRepository(repositoryUrl)?.name || "Project")}`
    : directory;
  const changeRepository = (value: string) => {
    const previous = parseProjectRepository(repositoryUrl);
    const next = parseProjectRepository(value);
    setRepositoryUrl(value);
    setError(null);
    if (next && (!name.trim() || name === previous?.name))
      setName(next.name.slice(0, 80));
  };
  const changeName = (value: string) => {
    nameEdited.current = !!value.trim();
    // Names such as Design/2027 must not silently become GitHub repositories.
    const address = isExplicitProjectRepositoryAddress(value);
    const repository =
      repositoryCreation && address ? parseProjectRepository(value) : null;
    if (repository) {
      if (source !== "repository") chooseSource("repository");
      setError(null);
      setRepositoryUrl(value.trim());
      setName(repository.name.slice(0, 80));
    } else setName(value.slice(0, 80));
  };

  const [directories, setDirectories] = useState<readonly ProjectDirectory[]>(
    [],
  );
  const [initialDirectories, setInitialDirectories] = useState<
    readonly ProjectDirectory[]
  >([]);
  const [icon, setIcon] = useState<string | null>(null);
  const [initial, setInitial] = useState<{
    name: string;
    icon: string | null;
  } | null>(null);
  useEffect(() => {
    if (snapshot && !initial) {
      const value = resolveProjectIcon(snapshot, projectKey);
      const comparison = projectAliasComparisonKey(
        projectKey,
        snapshot.platform,
      );
      const savedName =
        snapshot.aliases.find(
          (row) =>
            projectAliasComparisonKey(row.projectKey, snapshot.platform) ===
            comparison,
        )?.alias ?? title;
      setInitial({ name: savedName, icon: value });
      setName(savedName);
      setIcon(value);
      const roots = resolveProjectDirectories(snapshot, projectKey) ?? [];
      setDirectories(roots);
      setInitialDirectories(roots);
    }
  }, [snapshot, initial, title, projectKey]);
  const initializedCreationKey = useRef(projectKey);
  useEffect(() => {
    if (
      !create ||
      !snapshot ||
      !initial ||
      initializedCreationKey.current === projectKey
    )
      return;
    initializedCreationKey.current = projectKey;
    const comparison = projectAliasComparisonKey(projectKey, snapshot.platform);
    const savedName =
      snapshot.aliases.find(
        (row) =>
          projectAliasComparisonKey(row.projectKey, snapshot.platform) ===
          comparison,
      )?.alias ?? "";
    const savedIcon = resolveProjectIcon(snapshot, projectKey);
    const savedDirectories =
      resolveProjectDirectories(snapshot, projectKey) ?? [];
    if (directory) {
      setName((current) =>
        !current.trim() || !nameEdited.current
          ? savedName || projectDirectoryName(directory).slice(0, 80)
          : current,
      );
    }
    setIcon((current) => (current === initial.icon ? savedIcon : current));
    setDirectories((current) =>
      JSON.stringify(current) === JSON.stringify(initialDirectories)
        ? savedDirectories
        : current,
    );
    setInitial({ name: savedName, icon: savedIcon });
    setInitialDirectories(savedDirectories);
  }, [create, projectKey, directory, snapshot, initial, initialDirectories]);
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
  useEffect(() => {
    if (!visible) return;
    void refreshRemoteProjectAliases(
      deviceId,
      () => invoke(deviceId, PROJECT_ALIASES_GET_CHANNEL, []),
      () => isMobileAuthOwnerCurrent(owner),
    );
  }, [deviceId, invoke, owner, visible]);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available =
    !!initial && (snapshot?.settingsVersion ?? 0) >= (create ? 6 : 2);
  const dirty =
    !!initial &&
    ((create && (!!directory.trim() || !!repositoryUrl.trim())) ||
      name.trim() !== initial.name ||
      icon !== initial.icon ||
      JSON.stringify(directories) !== JSON.stringify(initialDirectories));
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
      (create && (snapshot?.settingsVersion ?? 0) < 7 && !directory.trim()) ||
      !snapshot?.ownerStamp ||
      !isMobileAuthOwnerCurrent(owner)
    )
      return;
    Keyboard.dismiss();
    if (
      repositoryCreation &&
      repositoryExpanded &&
      !parseProjectRepository(repositoryUrl)
    ) {
      setError(label("invalidRepository"));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    const value: {
      name?: string;
      icon?: string | null;
      directories?: readonly ProjectDirectory[];
    } = {};
    if (name.trim() !== initial!.name)
      value.name = name.trim() === defaultName ? "" : name.trim();
    if (create && !directory && name.trim()) value.name = name.trim();
    if (icon !== initial!.icon) value.icon = icon;
    if (
      (create &&
        resolveProjectDirectories(snapshot, projectKey) === undefined) ||
      JSON.stringify(directories) !== JSON.stringify(initialDirectories)
    )
      value.directories = directories;
    try {
      const result = (await invoke(deviceId, PROJECT_SETTINGS_SET_CHANNEL, [
        {
          create,
          projectKey,
          ...(create && repositoryUrl.trim()
            ? { repositoryUrl: repositoryUrl.trim() }
            : {}),
          field: "profile",
          value,
          ...snapshot.ownerStamp,
        },
      ])) as { createdProjectKey?: string };
      const createdDirectory = result?.createdProjectKey?.startsWith("local:")
        ? result.createdProjectKey.slice(6)
        : directory;
      if (!isMobileAuthOwnerCurrent(owner)) return;
      await refreshRemoteProjectAliases(
        deviceId,
        () => invoke(deviceId, PROJECT_ALIASES_GET_CHANNEL, []),
        () => isMobileAuthOwnerCurrent(owner),
        true,
      );
      if (create) onCreated?.(createdDirectory);
      onClose();
    } catch {
      if (mounted.current) setError(label(create ? "createFailed" : "failed"));
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
  const [formVisible, setFormVisible] = useState(true);
  const [browseTarget, setBrowseTarget] = useState<"main" | "additional">(
    "additional",
  );
  const maker = useMemo(
    () => createMobileMakerTransport({ deviceId, invoke }),
    [deviceId, invoke],
  );
  const picker = useOrcaWorkerDirectoryPicker({
    deviceId,
    maker,
    scope: existingKey,
    formEpoch: 0,
    canonicalDirectory: true,
    workingDir: directory,
    setSheetOpen: setFormVisible,
    onChoose: (path) => {
      if (!path) return;
      if (browseTarget === "main") setDirectory(path);
      else
        setDirectories((previous) =>
          path === directory ||
          previous.length >= 10 ||
          previous.some((item) => item.path === path)
            ? previous
            : [...previous, { path, access: "write" }],
        );
    },
  });
  const browse = (target: "main" | "additional") => {
    setBrowseTarget(target);
    picker.openDirectoryPicker();
  };
  const draw = (value: string | null, size: number) => (
    <ProjectIcon
      value={value}
      projectKey={projectKey}
      projectName={name.trim() || defaultName}
      automaticEnabled={!!directory && (snapshot?.settingsVersion ?? 0) >= 4}
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
    <>
      <FormSheet
        visible={visible && formVisible}
        title={label(
          stage === "profile"
            ? create
              ? "createTitle"
              : "title"
            : "chooseIcon",
        )}
        onClose={close}
        preventDismiss={busy || imageBusy || dirty || stage === "icon"}
        leadingAction={{
          label: label("cancel"),
          onPress: close,
          disabled: busy || imageBusy,
        }}
        trailingAction={{
          label: label(
            stage === "icon" ? "applyIcon" : create ? "createAction" : "save",
          ),
          busy: busy || imageBusy,
          disabled:
            disabled ||
            (stage === "profile"
              ? !dirty ||
                (create &&
                  (snapshot?.settingsVersion ?? 0) < 7 &&
                  !directory.trim())
              : pickerInvalid),
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
              {repositoryCreation && (
                <View style={{ gap: spacing.sm }}>
                  <View style={styles.tabs}>
                    {(["local", "repository"] as const).map((item) => (
                      <MainWindowOptionButton
                        key={item}
                        variant="segmented"
                        label={label(`sourceShort_${item}`)}
                        accessibilityLabel={label(`source_${item}`)}
                        selected={source === item}
                        disabled={disabled}
                        style={{ flex: 1 }}
                        onPress={() => chooseSource(item)}
                      />
                    ))}
                  </View>
                  <Text style={[styles.note, noteColor]}>
                    {label(`sourceHint_${source}`)}
                  </Text>
                </View>
              )}

              <View style={styles.hero}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={label("changeIcon")}
                  disabled={disabled}
                  onPress={() => {
                    Keyboard.dismiss();
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
                      isProjectImage(icon) || isProjectImageDraft(icon)
                        ? 48
                        : 28,
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
                  <Text style={[styles.path, textColor]}>
                    {label("createNamePlaceholder")}
                  </Text>
                  <TextInput
                    accessibilityLabel={label("name")}
                    value={name}
                    onChangeText={changeName}
                    maxLength={repositoryCreation ? 4096 : 80}
                    editable={!disabled}
                    placeholder={
                      repositoryCreation
                        ? label("createNamePlaceholder")
                        : defaultName || label("name")
                    }
                    placeholderTextColor={colors.textPlaceholder}
                    autoFocus
                    selectTextOnFocus
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      Keyboard.dismiss();
                    }}
                    style={[
                      styles.nameInput,
                      styles.path,
                      textColor,
                      { borderColor: colors.border },
                    ]}
                  />
                </View>
              </View>
              {!create && (
                <Text style={[styles.note, noteColor]}>
                  {label("nameHint")}
                </Text>
              )}
              {!!directory &&
                (snapshot?.settingsVersion ?? 0) >= 4 &&
                (icon === null || automatic.result?.candidate) && (
                  <View style={{ gap: spacing.sm }}>
                    {icon === null && (
                      <Text style={[styles.note, noteColor]}>
                        {automatic.loading
                          ? label("autoLoading")
                          : automatic.result?.image &&
                              !automatic.result.candidate
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
              {repositoryCreation && repositoryExpanded && (
                <View style={{ gap: spacing.sm }}>
                  <Text style={[styles.note, noteColor]}>
                    {label("repository")}
                  </Text>
                  <TextInput
                    autoFocus
                    value={repositoryUrl}
                    onChangeText={changeRepository}
                    editable={!disabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={label("repository")}
                    placeholder={label("repositoryHint")}
                    placeholderTextColor={colors.textPlaceholder}
                    style={inputStyle}
                  />
                  {busy && repositoryUrl && (
                    <Text style={[styles.note, noteColor]}>
                      {label("cloning")}
                    </Text>
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
                <ProjectDirectoriesEditor
                  mainDirectory={directoryPreview}
                  automatic={automaticDirectory}
                  onChooseMainDirectory={
                    repositoryCreation && source === "local"
                      ? () => browse("main")
                      : undefined
                  }
                  showHint={!create}
                  copied={copied}
                  onMainDirectoryChange={
                    create && !automaticDirectory
                      ? (path) => {
                          setDirectory(path);
                        }
                      : undefined
                  }
                  onCopy={() =>
                    void Clipboard.setStringAsync(directory)
                      .then(() => setCopied(true))
                      .catch(() => setError(label("failed")))
                  }
                  allowAdd={(snapshot?.settingsVersion ?? 0) >= 6}
                  value={directories}
                  onChange={setDirectories}
                  disabled={disabled}
                  onBrowse={
                    projectKey.startsWith("remote:")
                      ? undefined
                      : () => browse(directoryPreview ? "additional" : "main")
                  }
                />
              </View>
            </>
          ) : (
            <>
              <View style={styles.pickerHero}>
                <View style={[tileStyle, styles.pickerPreview]}>
                  {draw(
                    pickerIcon,
                    isProjectImage(pickerIcon) ||
                      isProjectImageDraft(pickerIcon)
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
                          transform: [
                            { rotate: colorOpen ? "180deg" : "0deg" },
                          ],
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
                        <Text
                          style={[styles.path, textColor, { flexShrink: 1 }]}
                        >
                          {colorLabel("default")}
                        </Text>
                        {pickerColor === "default" && (
                          <Check
                            size={iconSize.sm}
                            color={colors.textPrimary}
                          />
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
                  <Text
                    style={[styles.note, noteColor, { textAlign: "center" }]}
                  >
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
                <Text style={[styles.note, noteColor]}>
                  {label("noResults")}
                </Text>
              ) : null}
            </>
          )}
        </View>
      </FormSheet>
      <OrcaWorkerDirectoryPicker
        directoryOnly
        picker={picker}
        deviceId={deviceId}
        workingDir={directory}
        mode="path"
      />
    </>
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
    width: 48,
    height: 48,
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
