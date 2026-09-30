import { useMemo, useRef } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "./DeviceLinkContext";
import {
  createMobileMakerTransport,
  type MobileMakerTransport,
} from "./mobileMakerTransport";

export function useMobileMakerTransport(
  deviceId: string,
): MobileMakerTransport {
  const { invoke } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const generation = useRef(accountGeneration);
  generation.current = accountGeneration;
  return useMemo(
    () =>
      createMobileMakerTransport({
        deviceId,
        invoke,
        isCurrent: () => generation.current === accountGeneration,
      }),
    [deviceId, invoke, accountGeneration],
  );
}
