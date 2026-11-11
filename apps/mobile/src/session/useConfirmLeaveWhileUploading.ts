import { usePreventRemove } from 'expo-router/react-navigation';
import { useNavigation } from 'expo-router';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

/**
 * 发送正在等附件上传时拦截所有离开方式(顶栏返回、iOS 边缘右滑、Android 返回键)。
 * 离开会丢弃在途上传,这条消息随之放弃发送,先让用户确认。
 *
 * 弹窗是原生模态,打开期间页面不卸载、上传可能已落定。发送方在等待上传返回后必须
 * `await` 返回的 waitForLeaveDecision():弹窗未决时等用户选择,返回 true 表示用户
 * 确认放弃(或已放弃),发送方应放弃发送;false 表示继续发送。
 */
export function useConfirmLeaveWhileUploading(active: boolean): () => Promise<boolean> {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const discardedRef = useRef(false);
  const pendingRef = useRef<Promise<boolean> | null>(null);
  usePreventRemove(active, ({ data }) => {
    // 弹窗已开时再次触发离开(再滑一次)不叠第二个弹窗。
    if (pendingRef.current) return;
    let settle!: (discard: boolean) => void;
    pendingRef.current = new Promise<boolean>((resolve) => { settle = resolve; });
    const decide = (discard: boolean) => {
      pendingRef.current = null;
      settle(discard);
    };
    Alert.alert(
      t('session.leaveWhileUploading.title'),
      t('session.leaveWhileUploading.body'),
      [
        { text: t('session.leaveWhileUploading.stay'), style: 'cancel', onPress: () => decide(false) },
        {
          text: t('session.leaveWhileUploading.discard'),
          style: 'destructive',
          onPress: () => {
            discardedRef.current = true;
            decide(true);
            navigation.dispatch(data.action);
          },
        },
      ],
      // Android 点弹窗外会直接关闭,等价于继续等待。
      { cancelable: true, onDismiss: () => decide(false) },
    );
  });
  return useCallback(async () => (await pendingRef.current) ?? discardedRef.current, []);
}
