import { createContext, useContext, useState, type ReactNode } from 'react';
import { AttachmentCollectionContext } from './AttachmentCollectionContext';
import { ChatSessionFileProvider, useChatSessionFile } from './ChatSessionFileContext';
import { ImageGalleryContext, ImageGalleryScopeContext } from './ImageGalleryContext';

const ToolPreviewContext = createContext<((preview: ReactNode) => void) | null>(null);

/** Own the open viewer above the message window and its transient activity rows. */
export function ToolPreviewHost({ children }: { children?: ReactNode }) {
  const [preview, setPreview] = useState<ReactNode>(null);
  return <ToolPreviewContext.Provider value={setPreview}>
    {children}
    {preview}
  </ToolPreviewContext.Provider>;
}

export function useToolPreview() {
  const host = useContext(ToolPreviewContext);
  const [localPreview, setLocalPreview] = useState<ReactNode>(null);
  const show = host ?? setLocalPreview;
  const file = useChatSessionFile();
  const attachments = useContext(AttachmentCollectionContext);
  const images = useContext(ImageGalleryContext);
  const scope = useContext(ImageGalleryScopeContext);
  function open(viewer: ReactNode) {
    show(<ChatSessionFileProvider value={file}>
      <AttachmentCollectionContext.Provider value={attachments}>
        <ImageGalleryContext.Provider value={images}>
          <ImageGalleryScopeContext.Provider value={scope}>{viewer}</ImageGalleryScopeContext.Provider>
        </ImageGalleryContext.Provider>
      </AttachmentCollectionContext.Provider>
    </ChatSessionFileProvider>);
  }
  return { open, close: () => show(null), localPreview };
}
