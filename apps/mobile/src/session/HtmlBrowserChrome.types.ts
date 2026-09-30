/** File actions always refer to the entry file; WebView history stays inside its preview. */
export interface HtmlBrowserChromeProps {
  title: string;
  path: string;
  address: string;
  website?: boolean;
  /** False keeps the editor open; validation feedback is owned by the caller. */
  onNavigate(address: string): boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  canGoBack: boolean;
  canGoForward: boolean;
  source: boolean;
  busy: boolean;
  loading: boolean;
  notice?: string | null;
  onClose(): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onShare(): void;
  onCopyPath(): void;
  onAddToTask(): void;
  onToggleSource(): void;
}

// Native controls keep a 44pt hit target; the scroll insets also clear the outer spacing.
export const HTML_BROWSER_CONTROL_SIZE = 44;
