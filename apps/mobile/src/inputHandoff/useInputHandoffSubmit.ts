import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";
import {
  INPUT_HANDOFF_ACTION_ID,
  INPUT_HANDOFF_GHOST_ID,
  PLUGIN_OAUTH_CHANNEL,
  inputHandoffPresentation,
  type InputHandoffPicture,
  type InputHandoffSnapshot,
  type InputHandoffSubmission,
} from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { runMobilePluginAuthorization } from "@/plugins/pluginAuthorizationController";
import { openMobilePluginOauthSession } from "@/plugins/pluginOauthSession";
import { pluginOauthPlatformCrypto } from "@/plugins/pluginOauthPlatformCrypto";

/**
 * Sends one 代输入 step answer to the execution computer through the signed,
 * end-to-end sealed v3 channel. The values never use the generic interaction
 * resolve path, so they never enter the relay's plain payloads or any store.
 *
 * `submit` sends a prepared form answer. `openPicture` asks for the step's
 * screenshot: it arrives inside the sealed offer, `answer` gets it, and the
 * tap or typing it resolves with goes back on the same exchange.
 */
export function useInputHandoffSubmit(deviceId: string) {
  const auth = useAuth(),
    link = useDeviceLink(),
    focused = useIsFocused();
  const owner = useRef(getMobileAuthOwner()).current,
    alive = useRef(true),
    operation = useRef(0);
  const live = useRef({ focused, epoch: link.connectionEpoch });
  live.current = { focused, epoch: link.connectionEpoch };
  useEffect(
    () => () => {
      alive.current = false;
      operation.current++;
    },
    [],
  );

  const run = async (
    snapshot: InputHandoffSnapshot,
    answer:
      | { submission: InputHandoffSubmission }
      | { picture(picture: InputHandoffPicture): Promise<InputHandoffSubmission> },
  ): Promise<void> => {
    const peer = auth.deviceId;
    if (!peer || !live.current.focused || AppState.currentState !== "active")
      throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    const generation = ++operation.current,
      epoch = link.connectionEpoch;
    const assertCurrent = () => {
      if (
        !alive.current ||
        generation !== operation.current ||
        !isMobileAuthOwnerCurrent(owner) ||
        !live.current.focused ||
        live.current.epoch !== epoch
      )
        throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    };
    const invoke = (raw: unknown, cleanup = false) =>
      link.invoke(deviceId, PLUGIN_OAUTH_CHANNEL, [raw], {
        preSend: () => {
          if (cleanup) {
            if (!isMobileAuthOwnerCurrent(owner) || live.current.epoch !== epoch)
              throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
          } else assertCurrent();
          if (!cleanup && AppState.currentState !== "active")
            throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        },
      });
    const action = {
      requestId: snapshot.requestId,
      actionId: INPUT_HANDOFF_ACTION_ID,
      expectedRevision: snapshot.revision,
    };
    let pending: InputHandoffSubmission | undefined =
      "submission" in answer ? answer.submission : undefined;
    const client = await openMobilePluginOauthSession({
      deviceId,
      peer,
      owner,
      ghostId: INPUT_HANDOFF_GHOST_ID,
      action,
      invoke,
      assertCurrent,
    });
    try {
      await runMobilePluginAuthorization({
        crypto: pluginOauthPlatformCrypto,
        action,
        kind: "input",
        invoke: client.request,
        assertCurrent,
        inputPresentation: inputHandoffPresentation(snapshot),
        inputSubmission: pending,
        ...("picture" in answer ? { inputPicture: answer.picture } : {}),
        clearInput: () => {
          pending = undefined;
        },
        pause: async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          while (AppState.currentState !== "active") {
            assertCurrent();
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
        },
        showAuthorization: async () => {
          throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        },
      });
    } finally {
      pending = undefined;
      client.dispose();
    }
  };

  return {
    submit: (snapshot: InputHandoffSnapshot, submission: InputHandoffSubmission) =>
      run(snapshot, { submission }),
    openPicture: (
      snapshot: InputHandoffSnapshot,
      answer: (picture: InputHandoffPicture) => Promise<InputHandoffSubmission>,
    ) => run(snapshot, { picture: answer }),
  };
}
