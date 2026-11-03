/**
 * What the owner can do with a QR code from the computer, on this phone:
 * open its link here (an app that handles the link takes over, for example to
 * confirm a sign-in), hand the image to the share sheet (save it, then pick it
 * from the album in an app's scanner, or send it on), or copy what it says.
 */
import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Directory, File, Paths } from "expo-file-system";
import { inputHandoffQrLink, type InputHandoffPicture, type InputHandoffQr } from "@cindy/device-link";

const SHARE_DIR = "input-handoff-qr";
/** The share sheet may still read the file after it returns; the code is removed soon after. */
const SHARE_KEEP_MS = 120_000;

/** Opens the code's link here, as a phone camera would: a web link, or an app link the phone hands to its app. */
export async function openInputHandoffQrLink(qr: InputHandoffQr): Promise<boolean> {
  const link = inputHandoffQrLink(qr);
  if (!link) return false;
  try {
    await Linking.openURL(link.url);
    return true;
  } catch {
    return false;
  }
}

export async function copyInputHandoffQr(qr: InputHandoffQr): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(qr.text);
    return true;
  } catch {
    return false;
  }
}

async function removeShared(): Promise<void> {
  try {
    const directory = new Directory(Paths.cache, SHARE_DIR);
    if (!directory.exists) return;
    const FileSystem = await import("expo-file-system/legacy");
    await Promise.all(
      directory.list().map((entry) => FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined)),
    );
  } catch {
    // Best effort: the cache directory is the operating system's to clear too.
  }
}

/** Hands the code's image to the system share sheet (Save Image, or another app). */
export async function shareInputHandoffQr(picture: InputHandoffPicture): Promise<boolean> {
  // Only the latest shared code is ever kept, and only briefly.
  await removeShared();
  let uri: string | null = null;
  try {
    const directory = new Directory(Paths.cache, SHARE_DIR);
    directory.create({ intermediates: true, idempotent: true });
    const file = new File(directory, `qr-${Date.now().toString(36)}.jpg`);
    uri = file.uri;
    const FileSystem = await import("expo-file-system/legacy");
    await FileSystem.writeAsStringAsync(file.uri, picture.data, { encoding: FileSystem.EncodingType.Base64 });
    const sharing = await import("expo-sharing");
    await sharing.shareAsync(file.uri, { mimeType: "image/jpeg", UTI: "public.jpeg" });
    setTimeout(() => void removeShared(), SHARE_KEEP_MS);
    return true;
  } catch {
    if (uri) await removeShared();
    return false;
  }
}
