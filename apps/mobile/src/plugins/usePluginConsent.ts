import { useEffect, useRef } from "react";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import type {
  PluginManagementController,
  PluginManagementState,
} from "./pluginManagementController";
export interface PluginManagementConfirmationProps {
  state: PluginManagementState;
  controller: PluginManagementController;
  deviceName: string;
  active: boolean;
}
/** A late sheet callback cannot answer a different request or replacement controller. */
export function usePluginConsent({
  state,
  controller,
  active,
}: PluginManagementConfirmationProps) {
  const owner = useRef(getMobileAuthOwner()).current;
  const live = useRef({ controller, active });
  live.current = { controller, active };
  useEffect(() => () => { live.current = { ...live.current, active: false }; }, []);
  const consent = state.receipt?.consent;
  const requestId = consent?.requestId;
  const operationId = state.operationId;
  return {
    consent,
    visible: active && state.outcome === "confirmation" && Boolean(consent),
    answer: (accepted: boolean) => {
      const current = controller.getState();
      if (
        !live.current.active ||
        live.current.controller !== controller ||
        !isMobileAuthOwnerCurrent(owner) ||
        !current.online ||
        current.busy ||
        current.outcome !== "confirmation" ||
        current.operationId !== operationId ||
        current.receipt?.consent?.requestId !== requestId
      )
        return;
      void controller.answer(accepted);
    },
  };
}
