import { toLocalFileUrl } from '@/lib/localPathResolver';
import { activateInlineLinkFromKeyboard } from './linkInteraction';
import { useFileChipContextMenu } from './useFileChipContextMenu';

/** Bare image paths in user messages use the same file actions as Markdown references. */
export function UserMessageImageLink({
  path,
  onOpen,
}: {
  path: string;
  onOpen?: (url: string) => void;
}) {
  const fileMenu = useFileChipContextMenu({
    fileName: path,
    filePath: path,
    getAbsPath: () => path,
    onOpenPreview: onOpen ? () => onOpen(toLocalFileUrl(path)) : undefined,
  });
  return (
    <>
      <span
        data-chat-copy-content
        role="button"
        tabIndex={0}
        onClick={fileMenu.onActivate}
        onAuxClick={(event) => {
          if (event.button === 1) fileMenu.onActivate(event);
        }}
        onKeyDown={activateInlineLinkFromKeyboard}
        onContextMenu={fileMenu.onContextMenu}
        className="underline underline-offset-2 cursor-pointer break-all"
      >
        {path}
      </span>
      {fileMenu.menu}
    </>
  );
}
