import {
  transferClipboardContent as transfer,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";
export async function transferClipboardContent(
  action: "copy" | "paste",
  lease: string,
  request: <T>(message: RemoteDesktopRequest) => Promise<T>,
  check: () => void,
): Promise<void> {
  const native = remotePresentation;
  if (!native?.readClipboard || !native.writeClipboard)
    throw new Error("CLIPBOARD_UPGRADE");
  return transfer(action, lease, request, check, {
    read: native.readClipboard.bind(native),
    write: native.writeClipboard.bind(native),
  });
}
