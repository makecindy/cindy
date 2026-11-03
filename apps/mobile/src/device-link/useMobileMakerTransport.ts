import { useMemo, useRef } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "./DeviceLinkContext";
import { deviceLinkMediaApiBaseUrl } from '@/device-link/selfHostedRelayRouting';
import { readRemoteTextFilePreview } from '@/session/remoteAbsFileFetch';
import type { MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import {
  createMobileMakerTransport,
  type MobileMakerTransport,
} from "./mobileMakerTransport";

export function useMobileMakerTransport(
  deviceId: string,
): MobileMakerTransport {
  const { invoke, openLink } = useDeviceLink();
  const { accountGeneration, apiFetch } = useAuth();
  const generation = useRef(accountGeneration);
  generation.current = accountGeneration;
  return useMemo(
    () => {
      const isCurrent = () => generation.current === accountGeneration;
      const assertCurrent = () => {
        if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
      };
      const maker = createMobileMakerTransport({
        deviceId,
        invoke,
        isCurrent,
      });
      const readPreview = maker.fs.readTextFilePreview;
      maker.fs.readTextFilePreview = (path, options) => readRemoteTextFilePreview({
        maker, deviceId, openLink, isCurrent,
        readPreview: (path) => readPreview(path, { allowFileTransfer: true }),
        presignGet: (key) => apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
          baseUrl: deviceLinkMediaApiBaseUrl(key), method: 'POST', body: { key }, assertCurrent,
        }),
        deleteOssObject: (key) => {
          if (isCurrent()) void apiFetch('/api/device-link/media', {
            baseUrl: deviceLinkMediaApiBaseUrl(key), method: 'DELETE', body: { key }, assertCurrent,
          }).catch(() => undefined);
        },
      }, path, options?.signal);
      return maker;
    },
    [deviceId, invoke, openLink, accountGeneration, apiFetch],
  );
}
