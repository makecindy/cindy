import { Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { checkForUpdateWithToast } from '@/lib/checkForUpdateWithToast';
import { createLogger } from '@/lib/logger';

const log = createLogger('MenuButton');
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function MenuButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 尺寸与 ChromeActions 的折叠按钮同规格(h-7 / 图标 15 / rounded-md),
            与折叠态标题行图标(「…」h-7 / 15)视觉重量一致。 */}
        <button
          className={cn(
            'flex items-center justify-center',
            'h-7 w-7 rounded-md',
            'text-titlebar-icon',
            'transition-colors',
            'hover:bg-titlebar-button-hover',
            'focus-visible:outline-none',
          )}
          aria-label={t('titleBar.menu')}
        >
          <Menu size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="bg-titlebar border-titlebar-border"
      >
        <DropdownMenuItem
          className="focus:bg-titlebar-button-hover"
          onSelect={() => {
            log.info('Help clicked');
            navigate('/settings?tab=help');
          }}
        >
          {t('titleBar.menuItems.help')}
        </DropdownMenuItem>
        {/* Issue 页入口:与 macOS 系统菜单「帮助 → 问题反馈」等价,但此处常驻应用内左上角
            菜单,Windows / Linux(无系统菜单)也能访问 —— 否则非 mac 平台无可见入口。
            navigate('/issues') 与 MainLayout 的 'open-issues' 系统菜单命令同一行为。

            标签**刻意不是术语**「Issue」:菜单项回答的是「点这里能干什么」,而它的邻居
            全是动作短语(帮助 / 检查更新);夹一个英文名词既断了风格,也让不熟悉 GitHub
            的用户不知道该不该点。术语裁决(i18n/GLOSSARY.md)管的是指代那类对象的位置
            —— 页面标题与正文仍写 Issue,因为点进去就跳 GitHub,名字必须对得上。 */}
        <DropdownMenuItem
          className="focus:bg-titlebar-button-hover"
          onSelect={() => {
            log.info('Issues clicked');
            navigate('/issues');
          }}
        >
          {t('titleBar.menuItems.issues')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="focus:bg-titlebar-button-hover"
          onSelect={() => { void checkForUpdateWithToast(t); }}
        >
          {t('titleBar.menuItems.checkForUpdates')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
