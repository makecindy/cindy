import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../src/renderer/components/ui/dropdown-menu';
import { Tip } from '../../../src/renderer/components/ui/tooltip';

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
  cases: ['default'],
  render: () => (
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
