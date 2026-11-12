import { pickFileIcon } from '@/components/ui/file-type-icon';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PreviewTreeNode } from '../lib/marketDetailViewModel';

interface MarketPreviewTreeProps {
  nodes: PreviewTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface MarketPreviewTreeRowProps {
  node: PreviewTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/** File tree used by both the full market detail page and the half-screen preview panel. */
export function MarketPreviewTree({ nodes, selectedPath, onSelect }: MarketPreviewTreeProps) {
  return (
    <div className="flex flex-col gap-[2px]">
      {nodes.map((node) => (
        <MarketPreviewTreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MarketPreviewTreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: MarketPreviewTreeRowProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isFolder = node.type === 'folder';
  const isSelected = node.type === 'file' && selectedPath === node.path;
  const Icon = isFolder ? (expanded ? FolderOpen : Folder) : pickFileIcon(node.name);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isFolder) setExpanded((value) => !value);
          else onSelect(node.path);
        }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors',
          isSelected ? 'bg-[var(--settings-btn-secondary-bg)]' : 'hover:bg-[var(--surface-hover)]',
        )}
        style={{ paddingLeft: 4 + depth * 16 }}
        title={node.path}
      >
        {isFolder ? (
          expanded ? (
            <ChevronDown size={13} className="shrink-0 text-[var(--settings-theme-icon)]" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-[var(--settings-theme-icon)]" />
          )
        ) : (
          <span aria-hidden className="inline-block w-[13px] shrink-0" />
        )}
        <Icon size={13} className="shrink-0 text-[var(--settings-theme-icon)]" />
        <span className="truncate font-mono text-sm text-[var(--msg-assistant-text)]">
          {node.name}{isFolder ? '/' : ''}
        </span>
      </button>
      {isFolder && expanded && node.children.map((child) => (
        <MarketPreviewTreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
