/** File actions always refer to the entry file; WebView history stays inside its preview. */
export interface FilePreviewChromeProps {
  title: string;
  path: string;
  /** File details belong in the menu, leaving the reading surface uncluttered. */
  meta?: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Shown outside a navigation route (Modal): every control stays in the page, never in the host route's bar. */
  standalone?: boolean;
  source?: boolean;
  busy: boolean;
  /** The file has not opened yet: address editing and the more menu stay disabled. */
  pending?: boolean;
  notice?: string | null;
  /** Set while the notice describes a cancellable export: the notice shows a Cancel button. */
  onCancelNotice?: () => void;
  onClose(): void;
  onShare(): void;
  onCopyPath(): void;
  onAddToTask(): void;
  onToggleSource?: () => void;
}

export interface HtmlBrowserChromeProps extends FilePreviewChromeProps {
  document?: false;
  address: string;
  website?: boolean;
  /** False keeps the editor open; validation feedback is owned by the caller. */
  onNavigate(address: string): boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  source: boolean;
  loading: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onToggleSource(): void;
}

export interface DocumentPreviewChromeProps extends FilePreviewChromeProps {
  document: true;
}

// Native controls keep a 44pt hit target; the scroll insets also clear the outer spacing.
export const HTML_BROWSER_CONTROL_SIZE = 44;
