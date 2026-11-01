/**
 * 代输入 on the phone: a strip above the composer says where the computer
 * needs the owner, and 填写 opens the native sheet with just the fields to
 * type (system secure field + AutoFill hints so 1Password / Passwords can
 * fill them). Typed values stay in this component and leave only through the
 * sealed per-step channel.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View, useWindowDimensions } from "react-native";
import { AppWindow, Globe, Lock, QrCode, SquareTerminal } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type {
  InputHandoffAction,
  InputHandoffSnapshot,
  InputHandoffValues,
} from "@cindy/device-link";
import {
  inputHandoffHeldElsewhere,
  inputHandoffStepKey,
} from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import { Text } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  type MainWindowAction,
} from "@/components/MobilePrimitives";
import { useRemoteDeviceIdentity } from "@/session/remoteSessionStore";
import { iconSize, iconStroke, useTheme, useThemedStyles } from "@/theme";
import { useGuardedPush } from "@/utils/useGuardedPush";
import {
  InputHandoffPictureStep,
  rememberInputHandoffPictureOpened,
} from "./InputHandoffPictureStep";
import { InputHandoffDeviceCode } from "./InputHandoffDeviceCode";
import { InputHandoffQrCode } from "./InputHandoffQrCode";
import { InputHandoffSheet } from "./InputHandoffSheet";
import { inputHandoffWarnings, type InputHandoffQrSheet } from "./inputHandoffSheetModel";
import {
  copyInputHandoffQr,
  openInputHandoffQrLink,
  shareInputHandoffQr,
} from "./inputHandoffQrActions";
import { useInputHandoffQr } from "./useInputHandoffQr";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import {
  changedInputHandoffValues,
  inputHandoffPlace,
  inputHandoffPlaceKind,
  inputHandoffSheetHasContent,
} from "./inputHandoffNative";
import { useInputHandoffSubmit } from "./useInputHandoffSubmit";

type Decision = "done" | "cancel" | "stay" | "refresh" | "claim" | "picture";

export function InputHandoffCard({
  deviceId,
  snapshot,
  decisionBusy,
  onDecision,
  onQuietDecision,
}: {
  deviceId: string;
  snapshot: InputHandoffSnapshot;
  decisionBusy: boolean;
  onDecision(decision: Record<string, unknown>): void;
  /** Background decision that never marks the card busy (quiet claim). */
  onQuietDecision?(decision: Record<string, unknown>): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const handoff = useInputHandoffSubmit(deviceId);
  const selfDeviceId = useAuth().deviceId;
  const heldElsewhere = inputHandoffHeldElsewhere(snapshot, {
    deviceId: selfDeviceId,
  });
  const stepKey = inputHandoffStepKey(snapshot);
  // Bumped when an answer clears the draft on the same screen, so native fields (which keep their own text) start empty too.
  const [fieldEpoch, setFieldEpoch] = useState(0);
  const started = useRef(false);
  const [draft, setDraft] = useState<InputHandoffValues>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stays wanted across steps: after Continue the sheet hides while the
  // computer types and comes back by itself for the next screen to fill.
  const [sheetWanted, setSheetWanted] = useState(false);
  const push = useGuardedPush();
  const devices = useRemoteDeviceIdentity();
  // Every new screen starts from a clean draft; stale values are never reused.
  // Holder changes on the same screen keep what the owner is typing.
  useEffect(() => {
    setDraft({});
    setError(null);
    started.current = false;
  }, [stepKey]);
  useEffect(() => {
    if (snapshot.terminal) setSheetWanted(false);
  }, [snapshot.terminal]);
  const change = (id: string, value: string) => {
    // Starting to type on an unheld screen takes the handoff quietly.
    if (!started.current) {
      started.current = true;
      if (!snapshot.holder)
        onQuietDecision?.({
          kind: "input_handoff",
          action: "claim",
          expectedRevision: snapshot.revision,
        });
    }
    setDraft((d) => ({ ...d, [id]: value }));
  };

  const busy = decisionBusy || sending;
  const decide = (action: Decision) => {
    if (action === "picture")
      rememberInputHandoffPictureOpened(snapshot.requestId);
    onDecision({
      kind: "input_handoff",
      action,
      expectedRevision: snapshot.revision,
    });
  };
  const submit = async (action: InputHandoffAction) => {
    if (busy || snapshot.remoteInput !== true) return;
    setSending(true);
    setError(null);
    const values = changedInputHandoffValues(snapshot, draft);
    try {
      await handoff.submit(snapshot, {
        expectedRevision: snapshot.revision,
        values,
        action,
      });
      setDraft({});
      setFieldEpoch((n) => n + 1);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "INPUT_HANDOFF_STALE"
          ? t("interaction.inputHandoff.error.stale")
          : t("interaction.inputHandoff.error.submit"),
      );
    } finally {
      setSending(false);
    }
  };

  const sheetContent = inputHandoffSheetHasContent(snapshot, heldElsewhere);
  // Scan-to-sign-in: the code arrives sealed while the sheet is open, and follows refreshes by itself.
  const qrScan = snapshot.qr === "scan" && snapshot.picture === true;
  const [qrNotice, setQrNotice] = useState<string | null>(null);
  const qrView = useInputHandoffQr({
    snapshot,
    active: sheetWanted && sheetContent && qrScan,
    openPicture: handoff.openPicture,
    onError: (kind) => setError(kind ? t(`interaction.inputHandoff.error.${kind}`) : null),
  });
  useEffect(() => setQrNotice(null), [snapshot.revision]);
  // Large enough to scan from another screen, inside the sheet's margins.
  const qrSide = Math.min(260, useWindowDimensions().width - 96);
  const qrSheet: InputHandoffQrSheet | null = qrScan
    ? {
        view: qrView,
        notice: qrNotice,
        onOpen: () => {
          const qr = qrView.picture?.qr;
          if (qr)
            void openInputHandoffQrLink(qr).then((ok) => {
              if (!ok) setQrNotice(t("interaction.inputHandoff.qr.openFailed"));
            });
        },
        onShare: () => {
          const picture = qrView.picture;
          if (picture)
            void shareInputHandoffQr(picture).then((ok) => {
              if (!ok) setQrNotice(t("interaction.inputHandoff.qr.shareFailed"));
            });
        },
        onCopy: () => {
          const qr = qrView.picture?.qr;
          if (qr)
            void copyInputHandoffQr(qr).then((ok) =>
              setQrNotice(t(ok ? "interaction.inputHandoff.qr.copied" : "interaction.inputHandoff.qr.copyFailed")),
            );
        },
      }
    : null;
  // A live view of just the target window on the computer running the task.
  // Navigation only: the computer picks the window from the request id.
  const openLiveView =
    snapshot.liveView && !snapshot.terminal
      ? () => {
          setSheetWanted(false);
          push({
            pathname: "/devices/desktop/[deviceId]",
            params: {
              deviceId,
              deviceName:
                devices.find((device) => device.deviceId === deviceId)?.name ||
                deviceId,
              handoff: snapshot.requestId,
            },
          });
        }
      : undefined;
  const skip: MainWindowAction = {
    label: t("interaction.inputHandoff.action.skip"),
    disabled: busy,
    tone: "secondary",
    testID: "interaction.inputHandoff.skip",
    onPress: () => decide("cancel"),
  };
  const handBack: MainWindowAction = {
    label: t("interaction.inputHandoff.action.done"),
    disabled: busy,
    tone: "primary",
    onPress: () => decide("done"),
  };

  // Inline actions sit on the strip's row; a status line moves them below it.
  let status: string | null = null;
  let spinner = false;
  let actions: MainWindowAction[] = [];
  if (snapshot.terminal) {
    status = t(
      (snapshot.phase === "failed" ||
        snapshot.failure === "nothing_to_fill") &&
        snapshot.failure
        ? `interaction.inputHandoff.failure.${snapshot.failure}`
        : `interaction.inputHandoff.terminal.${snapshot.phase}`,
    );
  } else if (snapshot.phase === "ready" && heldElsewhere) {
    status = t("interaction.inputHandoff.holder.elsewhere", {
      device: holderLabel(snapshot, t),
    });
    actions = [
      skip,
      {
        label: t("interaction.inputHandoff.action.claim"),
        disabled: busy,
        tone: "primary",
        onPress: () => {
          setSheetWanted(true);
          decide("claim");
        },
      },
    ];
  } else if (snapshot.phase === "ready" && snapshot.qr === "scanned") {
    // The code was scanned; the sign-in finishes on the phone that scanned it.
    spinner = true;
    status = t("interaction.inputHandoff.qr.scanned");
    actions = [skip, handBack];
  } else if (snapshot.phase === "ready" && snapshot.directSignIn && openLiveView) {
    // A sign-in happens on the window, here through its live view; without one, the form below finishes it.
    // With a picture the page could not be read, so the end cannot be seen either: the owner says when.
    status = t(
      snapshot.picture
        ? "interaction.inputHandoff.directSignIn.hintUnread"
        : "interaction.inputHandoff.directSignIn.hint",
    );
    actions = [
      skip,
      ...(snapshot.picture ? [{ ...handBack, tone: "secondary" as const }] : []),
      {
        label: t("interaction.inputHandoff.action.openRemoteDesktop"),
        disabled: busy,
        tone: "primary",
        testID: "interaction.inputHandoff.openRemoteDesktop",
        onPress: openLiveView,
      },
    ];
  } else if (snapshot.phase === "ready" && sheetContent) {
    actions = [
      skip,
      {
        label: t(qrScan ? "interaction.inputHandoff.action.scan" : "interaction.inputHandoff.action.fill"),
        disabled: busy,
        tone: "primary",
        testID: "interaction.inputHandoff.fill",
        onPress: () => setSheetWanted(true),
      },
    ];
  } else if (snapshot.phase === "ready") {
    // Nothing left to type here (the owner stayed on, or an action did not take).
    status =
      inputHandoffWarnings(snapshot, t)[0] ??
      t("interaction.inputHandoff.nothingLeft");
    actions = [skip, handBack];
  } else if (snapshot.phase === "finishing") {
    actions = [
      {
        label: t("interaction.inputHandoff.action.stay"),
        disabled: busy,
        tone: "secondary",
        onPress: () => decide("stay"),
      },
      handBack,
    ];
  } else {
    spinner = true;
    status = t(
      snapshot.phase === "working"
        ? "interaction.inputHandoff.phase.working"
        : "interaction.inputHandoff.phase.reading",
    );
    actions = [skip];
  }
  const below = Boolean(status) || snapshot.phase === "finishing";

  const place = inputHandoffPlace(snapshot.source);
  const kind = inputHandoffPlaceKind(snapshot);
  const Icon = snapshot.qr
    ? QrCode
    : kind === "web"
      ? Globe
      : kind === "terminal"
        ? SquareTerminal
        : AppWindow;
  return (
    <View style={styles.strip} testID="interaction.inputHandoff.strip">
      <View style={styles.stripRow}>
        <View style={styles.stripIcon}>
          <Icon
            color={colors.textPrimary}
            size={iconSize.lg}
            strokeWidth={iconStroke.regular}
          />
        </View>
        <View style={styles.stripText}>
          <Text numberOfLines={2} style={styles.label}>
            {snapshot.purpose}
          </Text>
          <View style={styles.place}>
            {place.secure ? (
              <Lock
                color={colors.textSecondary}
                size={iconSize.xs}
                strokeWidth={iconStroke.regular}
              />
            ) : null}
            <Text numberOfLines={1} style={styles.placeText}>
              {place.label}
            </Text>
          </View>
        </View>
        {actions.length > 0 && !below ? (
          <View style={styles.stripActions}>
            {actions.map((action) => (
              <MainWindowActionButton
                key={action.label}
                density="compact"
                action={action}
              />
            ))}
          </View>
        ) : null}
      </View>
      {snapshot.phase === "finishing" ? (
        <FinishingText until={snapshot.finishingUntil} style={styles.body} />
      ) : null}
      {status ? (
        <View style={styles.stripStatus}>
          {spinner ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <Text style={[styles.body, styles.stripStatusText]}>{status}</Text>
        </View>
      ) : null}
      {error && !sheetWanted ? <Text style={styles.error}>{error}</Text> : null}
      {actions.length > 0 && below ? (
        <MainWindowActionGroup density="compact" primaryActions={actions} />
      ) : null}
      {openLiveView && !sheetContent ? (
        <Pressable
          accessibilityRole="button"
          onPress={openLiveView}
          style={styles.quietLink}
          testID="interaction.inputHandoff.liveView"
        >
          <Text style={styles.meta}>
            {t("interaction.inputHandoff.action.liveView")}
          </Text>
        </Pressable>
      ) : null}
      <InputHandoffSheet
        visible={sheetWanted && sheetContent}
        snapshot={snapshot}
        stepKey={`${stepKey}#${fieldEpoch}`}
        draft={draft}
        busy={busy}
        error={error}
        qr={qrSheet}
        embedded={
          // Mounted only while the sheet shows: a hidden SwiftUI sheet still renders its children.
          !(sheetWanted && sheetContent) ? null : qrScan ? (
            <InputHandoffQrCode view={qrView} side={qrSide} />
          ) : snapshot.picture ? (
            // One screenshot per revision; no quiet claim here (it would bump the revision).
            <InputHandoffPictureStep
              key={`${snapshot.requestId}:${snapshot.revision}`}
              snapshot={snapshot}
              busy={busy}
              openPicture={handoff.openPicture}
              onDecide={decide}
              onError={setError}
            />
          ) : (
            <InputHandoffDeviceCode snapshot={snapshot} />
          )
        }
        onChange={change}
        onSubmit={() => void submit({ kind: "submit" })}
        onDone={() => {
          setSheetWanted(false);
          decide("done");
        }}
        onPicture={() => decide("picture")}
        onLiveView={openLiveView}
        onClose={() => setSheetWanted(false)}
      />
    </View>
  );
}

function holderLabel(
  snapshot: InputHandoffSnapshot,
  t: (key: string) => string,
): string {
  const holder = snapshot.holder;
  if (holder?.local) return t("interaction.inputHandoff.holder.host");
  if (holder?.name) return holder.name;
  return t(
    holder?.platform === "mobile"
      ? "interaction.inputHandoff.holder.phone"
      : "interaction.inputHandoff.holder.otherDevice",
  );
}

function FinishingText({ until, style }: { until?: number; style: object }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  const seconds = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return (
    <Text style={style}>
      {until
        ? t("interaction.inputHandoff.phase.finishing", { count: seconds })
        : t("interaction.inputHandoff.phase.finishingNow")}
    </Text>
  );
}
