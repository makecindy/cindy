import { useEffect, useState } from "react";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import type { RemoteSession } from "@/session/types";
import { PluginTaskPickerView } from "./PluginTaskPickerView";

/** Host task chooser. Its list is never exposed to plugin JavaScript or cindy.tasks. */
export function PluginTaskPicker({
  deviceId,
  visible,
  onClose,
  onSelect,
}: {
  deviceId: string;
  visible: boolean;
  onClose(): void;
  onSelect(sessionId: string): void;
}) {
  const { invoke } = useDeviceLink();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    setRows([]);
    setQuery("");
    setLoading(true);
    setError(false);
    void invoke<RemoteSession[]>(
      deviceId,
      "local-db:sessions:list",
      [500, "active", { includePinned: true, fresh: true }],
      {
        preSend: () => {
          if (!current()) throw new Error("PLUGIN_TASK_PICKER_CLOSED");
        },
      },
    )
      .then((value) => {
        if (current())
          setRows(
            Array.isArray(value)
              ? value.filter(
                  (row) =>
                    row &&
                    typeof row.id === "string" &&
                    typeof row.title === "string" &&
                    row.status === "active" &&
                    row.orcaRole !== "worker",
                )
              : [],
          );
      })
      .catch(() => {
        if (current()) setError(true);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [deviceId, visible, invoke, attempt]);
  return (
    <PluginTaskPickerView
      deviceId={deviceId}
      visible={visible}
      query={query}
      rows={rows}
      loading={loading}
      error={error}
      onChangeQuery={setQuery}
      onRetry={() => setAttempt((value) => value + 1)}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}
