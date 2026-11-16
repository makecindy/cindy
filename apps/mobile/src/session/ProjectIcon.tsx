import {
  PROJECT_AUTO_ICON_CHANNEL,
  parseAutomaticProjectIcon,
  type AutomaticProjectIcon,
} from "@cindy/maker-shared/project-alias-sync";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { Folder } from "lucide-react-native";
import {
  parseProjectSymbol,
  parseProjectLetters,
  defaultProjectLetters,
  defaultProjectColor,
  projectIconInk,
  type ProjectIconColor,
  isProjectImage,
  isProjectImageDraft,
  PROJECT_ICON_IMAGE_CHANNEL,
} from "@cindy/maker-shared/project-alias-sync";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { Text } from "@/components/AppText";
import {
  useTheme,
  typeScale,
  lineHeight,
  type ThemeColors,
  radius,
  fontWeight,
  iconStroke,
} from "@/theme";
import { projectSymbolIcons } from "./projectSymbolIcons";
export function ProjectIcon({
  value,
  projectKey,
  projectName,
  deviceId,
  automaticEnabled = true,
  size = 24,
}: {
  value: string | null;
  projectKey: string;
  projectName: string;
  deviceId?: string | null;
  automaticEnabled?: boolean;
  size?: number;
}) {
  const { invoke } = useDeviceLink();
  const { colors, mode } = useTheme();
  const automatic = useAutomaticProjectIcon(
    projectKey,
    deviceId,
    value === null && automaticEnabled && !!projectKey,
  );
  const imageIdentity = JSON.stringify([
    getMobileAuthOwner(),
    deviceId ?? null,
    projectKey,
    value,
  ]);
  const [loaded, setLoaded] = useState<{
    identity: string;
    data: string;
  } | null>(null);
  useEffect(() => {
    if (!isProjectImage(value) || !deviceId) return;
    let active = true;
    const owner = getMobileAuthOwner();
    void sharedIconRequest(imageIdentity, () =>
      invoke(deviceId, PROJECT_ICON_IMAGE_CHANNEL, [{ projectKey }]).then(
        (data) => (typeof data === "string" ? data : null),
      ),
    )
      .promise.then((data) => {
        if (
          active &&
          typeof data === "string" &&
          isMobileAuthOwnerCurrent(owner)
        )
          setLoaded({ identity: imageIdentity, data });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [imageIdentity, invoke]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source =
    value === null && !automatic.result?.candidate
      ? automatic.result?.image
      : isProjectImageDraft(value)
        ? value
        : loaded?.identity === imageIdentity
          ? loaded.data
          : null;
  if (source && source !== failedSource)
    return (
      <Image
        source={{ uri: source }}
        style={{ width: size, height: size }}
        onError={() => setFailedSource(source)}
      />
    );
  const symbol = parseProjectSymbol(value);
  const letters =
    parseProjectLetters(value) ??
    (!value || isProjectImage(value) || isProjectImageDraft(value)
      ? {
          text: defaultProjectLetters(projectName),
          color: defaultProjectColor(projectName),
        }
      : null);
  if (letters) {
    const white = letters.color === "white";
    const ink =
      letters.color === "default"
        ? colors.textPrimary
        : projectIconInk(
            projectIconColor(colors, letters.color),
            mode === "dark",
          );
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.25,
          backgroundColor: white ? colors.taskTagWhite : `${ink}24`,
          ...(white ? { borderWidth: 1, borderColor: colors.border } : {}),
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Text
          numberOfLines={1}
          allowFontScaling={false}
          adjustsFontSizeToFit
          style={{
            color: white ? colors.taskTagWhiteCheck : ink,
            textAlign: "center",
            fontWeight: fontWeight.semibold,
            fontSize: size >= 32 ? typeScale.title : typeScale.micro,
            lineHeight: size >= 32 ? lineHeight.title : lineHeight.micro,
          }}
        >
          {letters.text}
        </Text>
      </View>
    );
  }
  const compactSymbolSize = size * 0.75;
  const Icon = symbol ? projectSymbolIcons[symbol.name] : Folder;
  if (symbol?.color === "white")
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.taskTagWhite,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon
          size={compactSymbolSize}
          color={colors.taskTagWhiteCheck}
          strokeWidth={iconStroke.project}
        />
      </View>
    );
  if (!value || isProjectImage(value) || value.startsWith("symbol:"))
    return (
      <Icon
        size={size}
        color={projectIconColor(colors, symbol?.color ?? "default")}
        strokeWidth={iconStroke.project}
      />
    );
  return (
    <Text
      style={{
        color: colors.textPrimary,
        textAlign: "center",
        fontSize: size >= 32 ? typeScale.largeTitle : typeScale.title,
        lineHeight: size >= 32 ? lineHeight.largeTitle : lineHeight.title,
      }}
    >
      {value}
    </Text>
  );
}

export function projectIconColor(
  colors: ThemeColors,
  color: ProjectIconColor,
): string {
  const palette: Record<ProjectIconColor, string> = {
    default: colors.textPrimary,
    blue: colors.taskTagBlue,
    purple: colors.taskTagPurple,
    pink: colors.taskTagPink,
    red: colors.taskTagRed,
    orange: colors.taskTagOrange,
    green: colors.taskTagGreen,
    teal: colors.taskTagTeal,
    yellow: colors.taskTagYellow,
    gray: colors.taskTagGray,
    coral: colors.taskTagCoral,
    indigo: colors.taskTagIndigo,
    white: colors.taskTagWhite,
  };
  return palette[color];
}

// Shared by list and settings previews: one host request per account/device/project.
const iconCache = new Map<
  string,
  { until: number; promise: Promise<AutomaticProjectIcon | string | null> }
>();
export function useAutomaticProjectIcon(
  projectKey: string,
  deviceId: string | null | undefined,
  enabled = true,
) {
  const { invoke } = useDeviceLink();
  const owner = getMobileAuthOwner();
  const identity = JSON.stringify([owner, deviceId, projectKey]);
  const [state, setState] = useState<{
    identity: string;
    result: AutomaticProjectIcon | null;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !deviceId) return;
    let live = true;
    setState({ identity, result: null, loading: true });
    const item = sharedIconRequest(identity, () =>
      Promise.resolve(
        invoke(deviceId!, PROJECT_AUTO_ICON_CHANNEL, [{ projectKey }]),
      ).then(parseAutomaticProjectIcon),
    );
    void item.promise.then((result) => {
      if (live && isMobileAuthOwnerCurrent(owner))
        setState({
          identity,
          result: typeof result === "string" ? null : result,
          loading: false,
        });
    });
    return () => {
      live = false;
    };
  }, [identity, enabled, invoke]);
  return state?.identity === identity
    ? state
    : { result: null, loading: enabled && !!deviceId };
}

function sharedIconRequest(
  identity: string,
  read: () => Promise<AutomaticProjectIcon | string | null>,
) {
  let item = iconCache.get(identity);
  if (!item || item.until < Date.now()) {
    if (iconCache.size >= 256) iconCache.clear();
    item = {
      until: Date.now() + 60_000,
      promise: Promise.resolve()
        .then(read)
        .catch(() => null),
    };
    iconCache.set(identity, item);
  }
  return item;
}
