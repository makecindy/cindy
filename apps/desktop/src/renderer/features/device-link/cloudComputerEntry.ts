/**
 * 云主机入口 —— 侧栏机器范围菜单与「远程连接 → 我的设备」共用的一份读取与打开逻辑。
 * ---------------------------------------------------------------------------
 * Model Access 告诉本账号能做什么(没有云主机可添加 / 正在准备 / 可管理,以及能否再添加一台),
 * 并给出本 realm 的账号中心云主机页地址;界面只决定在哪里展示。两处都在挂载时读一次:
 * 菜单只在展开时挂载,设置页只在打开「远程连接」时挂载,不轮询。
 */

import { useEffect, useState } from 'react';

import { useOptionalAuthUser, useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import { cloudComputerEntry } from '@cindy/maker-shared/device-list';

export type CloudComputerEntry = NonNullable<ReturnType<typeof cloudComputerEntry>>;
/** 入口本身的动作,外加「添加云主机」(已有云主机、还能再开一台时)。 */
export type CloudComputerAction = CloudComputerEntry['action'] | 'addCloud';

/** 本账号的云主机入口;不是组织成员、未开通或读取失败时为 null。 */
export function useCloudComputerEntry(): CloudComputerEntry | null {
  const user = useOptionalAuthUser();
  const generation = useOptionalDataOwnerGeneration();
  const member = user?.membershipKind === 'org' ? user.id : undefined;
  const org = user?.orgId;
  // 换账号或数据归属换代后,旧账号读回来的结果不再展示。
  const owner = JSON.stringify([member, org, generation]);
  const [result, setResult] = useState<{ owner: string; entry: CloudComputerEntry | null } | null>(null);
  useEffect(() => {
    if (!member || !org) return;
    let current = true;
    const read = window.electronAPI?.deviceLink?.cloudComputerEntry;
    if (read)
      void read()
        .then((value) => {
          if (current) setResult({ owner, entry: cloudComputerEntry(value, member, org) });
        })
        .catch(() => {
          if (current) setResult(null);
        });
    return () => {
      current = false;
    };
  }, [member, org, owner]);
  return result?.owner === owner ? result.entry : null;
}

/** 入口提供的动作,按展示顺序:入口自己的动作在前,能再开一台时随后是「添加云主机」。 */
export function cloudComputerActions(entry: CloudComputerEntry): CloudComputerAction[] {
  return 'canAdd' in entry && entry.canAdd ? [entry.action, 'addCloud'] : [entry.action];
}

/** 在浏览器里打开账号中心的云主机页;「添加云主机」直接打开下单表单。 */
export function openCloudComputerPage(entry: CloudComputerEntry, action: CloudComputerAction) {
  const url = new URL(entry.url);
  url.searchParams.set('app', BRAND_IDENTITY.primaryScheme);
  if (action === 'addCloud') url.searchParams.set('add', '1');
  return window.electronAPI.openExternal(url.href);
}
