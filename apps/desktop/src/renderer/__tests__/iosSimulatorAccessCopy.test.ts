import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

describe('iOS Simulator access copy', () => {
  it('explains that viewing is retained while control needs renewed authorization', () => {
    expect(zhCN.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '此权限仅对该任务生效。切换到其他任务后会保留查看授权，但控制会暂停；返回后请再次允许控制。',
    );
    expect(zhTW.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '此權限僅對該任務生效。切換到其他任務後會保留檢視授權，但控制會暫停；返回後請再次允許控制。',
    );
    expect(en.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      'This permission applies only to this session. Switching away retains viewing access but pauses control; allow control again after you return.',
    );
    expect(ja.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      'この権限はこのセッションにのみ適用されます。別のセッションへ切り替えても表示権限は保持されますが、操作は一時停止します。戻った後にもう一度操作を許可してください。',
    );
    expect(ko.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '이 권한은 이 세션에만 적용됩니다. 다른 세션으로 전환해도 보기 권한은 유지되지만 제어는 일시 중지됩니다. 돌아온 뒤 제어를 다시 허용하세요.',
    );
  });
});
