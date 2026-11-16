import { expect, it, vi } from 'vitest';
import { reconcileDeliveredNotifications } from '../notifications/notificationReconciliation';

// Unit regression: cleanup must target the captured notification identity, not its
// conversation. Existing push tests cover routing/registration, not asynchronous retirement.
const old = '11111111-1111-4111-8111-111111111111';
const later = '22222222-2222-4222-8222-222222222222';
const notice = (id: string, recipientId = 'account') => ({ request: { identifier: id,
  content: { data: { notificationId: id, recipientId, category: 'session-needs-reply' } } } });
it('only retires captured identities of the resolved account and retains unanswered/new alerts', async () => {
  const retire = vi.fn();
  await reconcileDeliveredNotifications({ presented: async () => [notice(old), notice(old, 'other-account')],
    current: () => true, resolve: async () => [`account:${old}`, `account:${later}`], retire });
  expect(retire).toHaveBeenCalledWith([{ identifier: old, id: old, recipientId: 'account', chat: false }]);
});
it('drops a late response after account change', async () => {
  let active = true;
  const retire = vi.fn();
  await reconcileDeliveredNotifications({ presented: async () => [notice(old)], current: () => active,
    resolve: async () => { active = false; return [`account:${old}`]; }, retire });
  expect(retire).not.toHaveBeenCalled();
});
