import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { AUTH_REGION } from "@/config/env";
import { hydratePrivacyConsent } from "@/update/updateConsentGate";
import { diagnosticSnapshot } from "./localDiagnostics";
import {
  parseDiagnosticUploadTarget,
  uploadDiagnosticSnapshot,
  type DiagnosticUploadResult,
} from "./diagnosticUpload";

const rawTarget = process.env.EXPO_PUBLIC_CINDY_LOG_UPLOAD_TARGET ?? "";
let uploading = false;
export function diagnosticUploadConfigured(): boolean {
  return parseDiagnosticUploadTarget(rawTarget, AUTH_REGION) !== null;
}

/** Only called by the settings action; no background upload or persistent retry queue. */
export async function uploadMobileDiagnostics(): Promise<DiagnosticUploadResult> {
  if (uploading) return { kind: "failed" };
  uploading = true;
  try {
    return await uploadDiagnosticSnapshot({
      rawTarget,
      region: AUTH_REGION,
      consent: hydratePrivacyConsent,
      snapshot: diagnosticSnapshot,
      randomBytes: Crypto.getRandomBytes,
      fetch,
      appVersion:
        Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "",
      platform: Platform.OS,
      osVersion: String(Platform.Version),
    });
  } finally {
    uploading = false;
  }
}
