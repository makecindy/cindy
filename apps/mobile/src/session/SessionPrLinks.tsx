import { useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  type SessionPrRef,
  type SessionPrRefAction,
  sessionPrUrl,
} from "@cindy/maker-shared";
import { Text, TextInput } from "@/components/AppText";
import { ActionPill } from "@/components/MobilePrimitives";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { useTheme } from "@/theme";
import { radius, spacing, typeScale } from "@/theme/tokens";

/** Uses the existing same-account association manager; historical links stay recoverable on phones. */
export function SessionPrLinks({
  sessionId,
  deviceId,
  readOnly = false,
}: {
  sessionId: string;
  deviceId: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const link = useDeviceLink();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [rows, setRows] = useState<SessionPrRef[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    locked.current = false;
    setBusy(false);
    setRows([]);
    setOpen(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [sessionId, deviceId]);
  const label = (key: string, options?: Record<string, unknown>) =>
    t(`session.githubPrs.${key}`, options);
  async function run(action: SessionPrRefAction | { action: "list" }) {
    if (locked.current) return;
    const gen = generation.current;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await link.invoke<SessionPrRef[]>(
        deviceId,
        "git-context:pr-refs:manage",
        [{ sessionId, ...action }],
      );
      if (gen !== generation.current) return;
      setRows(result);
      if (action.action === "add") setUrl("");
    } catch {
      if (gen === generation.current) setError(label("errors.failed"));
    } finally {
      if (gen === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const active = rows.filter(
    (row) => row.removedAt == null && row.associationSource !== "legacy",
  );
  const legacy = rows.filter(
    (row) => row.removedAt == null && row.associationSource === "legacy",
  );
  const archived = rows.filter((row) => row.removedAt != null);
  return (
    <View style={{ gap: spacing.sm }}>
      <ActionPill
        label={label("title")}
        onPress={() => {
          setOpen(!open);
          if (!open) void run({ action: "list" });
        }}
      />
      {open && (
        <>
          {busy && (
            <Text style={{ color: colors.textSecondary }}>
              {label("loading")}
            </Text>
          )}
          {!!error && (
            <Text
              accessibilityRole="alert"
              style={{ color: colors.textSecondary }}
            >
              {error}
            </Text>
          )}
          {[
            ...active,
            ...(history ? legacy : []),
            ...(removed ? archived : []),
          ].map((row) => {
            const inactive =
              row.removedAt != null || row.associationSource === "legacy";
            const group = active.filter(
              (item) => Boolean(item.pinned) === Boolean(row.pinned),
            );
            const index = group.findIndex((item) => item.id === row.id);
            return (
              <View key={row.id} style={{ gap: spacing.xs }}>
                <Text
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(sessionPrUrl(row))}
                  style={{
                    color: colors.textPrimary,
                    fontSize: typeScale.body,
                  }}
                >
                  {row.owner}/{row.repo} #{row.prNumber}
                </Text>
                {!readOnly && (
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      gap: spacing.xs,
                    }}
                  >
                    {inactive ? (
                      <ActionPill
                        disabled={busy}
                        label={label("restore")}
                        onPress={() =>
                          void run({ action: "restore", id: row.id })
                        }
                      />
                    ) : (
                      <>
                        <ActionPill
                          disabled={busy}
                          label={label(row.pinned ? "unpin" : "pin")}
                          onPress={() =>
                            void run({
                              action: row.pinned ? "unpin" : "pin",
                              id: row.id,
                            })
                          }
                        />
                        <ActionPill
                          disabled={busy}
                          label={label("remove")}
                          onPress={() =>
                            void run({ action: "remove", id: row.id })
                          }
                        />
                        {index > 0 && (
                          <ActionPill
                            disabled={busy}
                            label="↑"
                            accessibilityLabel={label("moveUp")}
                            onPress={() => {
                              const ids = group.map((item) => item.id);
                              [ids[index - 1], ids[index]] = [
                                ids[index],
                                ids[index - 1],
                              ];
                              void run({ action: "reorder", ids });
                            }}
                          />
                        )}
                      </>
                    )}
                  </View>
                )}
              </View>
            );
          })}
          {legacy.length > 0 && (
            <ActionPill
              label={label("legacy", { count: legacy.length })}
              onPress={() => setHistory(!history)}
            />
          )}
          {archived.length > 0 && (
            <ActionPill
              label={label("removed", { count: archived.length })}
              onPress={() => setRemoved(!removed)}
            />
          )}
          {!readOnly && (
            <>
              <TextInput
                accessibilityLabel={label("addLabel")}
                placeholder="https://github.com/owner/repo/pull/123"
                placeholderTextColor={colors.textSecondary}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                style={{
                  color: colors.textPrimary,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: radius.pill,
                  padding: spacing.md,
                }}
              />
              <ActionPill
                disabled={busy || !url.trim()}
                label={label("add")}
                onPress={() => void run({ action: "add", url: url.trim() })}
              />
            </>
          )}
        </>
      )}
    </View>
  );
}
