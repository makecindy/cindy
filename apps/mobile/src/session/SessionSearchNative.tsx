export interface SessionSearchNativeProps {
  visible: boolean;
  query: string;
  counter: string;
  hasHits: boolean;
  loadEarlier: {
    visible: boolean;
    disabled: boolean;
    label: string;
    accessibilityLabel: string;
  };
  onChangeQuery(value: string): void;
  onClose(): void;
  onMove(direction: "previous" | "next"): void;
  onLoadEarlier(): void;
}

export function SessionSearchNative(_props: SessionSearchNativeProps) {
  return null;
}
