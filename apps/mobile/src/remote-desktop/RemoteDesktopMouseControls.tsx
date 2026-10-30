export type MouseControlsProps = {
  bottom: number;
  right: number;
  compact: boolean;
  labels: Record<"left" | "right" | "wheel", string>;
  send(message: unknown): void;
};

export function RemoteDesktopMouseControls(_props: MouseControlsProps) {
  return null;
}
