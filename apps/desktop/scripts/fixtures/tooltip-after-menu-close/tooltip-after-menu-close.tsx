import { useEffect, useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { useLinkContextMenu } from '../../../src/renderer/components/chat/useLinkContextMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../src/renderer/components/ui/dropdown-menu';
import { Tip } from '../../../src/renderer/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../src/renderer/components/ui/popover';

function FocusHandoff() {
  const { onContextMenu, menu } = useLinkContextMenu('https://example.com', []);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const openEditor = (event: KeyboardEvent) => {
      if (event.key !== 'F2') return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', openEditor);
    return () => document.removeEventListener('keydown', openEditor);
  }, []);
  return (
    <div className="flex h-screen flex-col items-start gap-6 bg-content-area p-6 text-13 text-foreground">
      <p>右键链接打开菜单，再按 F2 打开编辑浮层；焦点应留在输入框。</p>
      <a
        href="https://example.com"
        onContextMenu={onContextMenu}
        onClick={(event) => event.preventDefault()}
      >
        File link
      </a>
      {menu}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>Open editor</PopoverTrigger>
        <PopoverContent>
          <input aria-label="New editor" className="bg-content-area text-foreground" />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function MoreMenu() {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Tip text="更多操作" side="bottom">
          <button
            type="button"
            aria-label="more"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cmd-palette-item-meta)] hover:bg-titlebar-button-hover"
          >
            ⋯
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem>归档</DropdownMenuItem>
        <DropdownMenuItem>删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

mountPage({
  cases: ['default', 'replacement-custom-focus'],
  render: (ctx) =>
    ctx.case === 'replacement-custom-focus' ? (
      <FocusHandoff />
    ) : (
      <div className="flex h-screen w-full flex-col gap-6 bg-content-area p-6 text-13 text-foreground">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">看一下这个游戏</span>
          <MoreMenu />
        </div>
        <p className="max-w-[420px] text-text-secondary">
          点 ⋯ 打开菜单，再点这块空白关闭菜单。焦点会回到 ⋯ 按钮，指针不在按钮上——提示不应该冒出来。
        </p>
      </div>
    ),
});
