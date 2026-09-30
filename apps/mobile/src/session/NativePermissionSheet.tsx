/**
 * 权限模式独立浮窗(Android / 兼容呈现;iOS 见 NativePermissionSheet.ios.tsx)。
 *
 * 交互与 iOS 同口径:点选某一档先收起面板,等 SheetModal 关闭动画播完(onClosed)
 * 再把选择交给调用方生效——Full access 确认弹层等后续呈现不会与本面板叠加。
 * 外观保持 Android:SheetModal + SheetSurface + RN 自绘行。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "./contextSheetModel";
import {
  MobilePermissionPickerList,
  type MobilePermissionPickerListProps,
} from "./MobilePermissionPickerList";
import { SheetModal } from "./SheetModal";
import { SheetSurface } from "./SheetSurface";

export interface NativePermissionSheetProps extends MobilePermissionPickerListProps {
  visible: boolean;
  onClose(): void;
}

export function NativePermissionSheet(props: NativePermissionSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        safeAreaTopInset: insets.top,
        screenHeight: height,
      }),
    [insets.top, height],
  );
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  const pending = useRef<(() => void) | null>(null);
  // 关闭动画期间调用方可能已重渲染;兑现时用最新的 onSelect,而不是点选那一刻的闭包。
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  useEffect(() => {
    if (!props.visible) return;
    setSnap("half");
    // 新一轮打开不继承上一轮未兑现的选择(例如关闭动画中途被重新打开)。
    pending.current = null;
  }, [props.visible]);
  return (
    <SheetModal
      backdropTestID={props.testID ? `${props.testID}.backdrop` : undefined}
      onBackdropPress={props.onClose}
      onClosed={() => {
        const action = pending.current;
        pending.current = null;
        action?.();
      }}
      onRequestClose={props.onClose}
      visible={props.visible}
    >
      <SheetSurface
        bottomInset={insets.bottom}
        heights={heights}
        onClose={props.onClose}
        onSnapChange={setSnap}
        snap={snap}
        testID={props.testID}
        title={t("models.picker.permissionTitle")}
      >
        <MobilePermissionPickerList
          activeMode={props.activeMode}
          disabled={props.disabled}
          onSelect={(mode) => {
            pending.current = () => onSelectRef.current(mode);
            props.onClose();
          }}
          options={props.options}
          rowStyle={props.rowStyle}
          testID={props.testID ? `${props.testID}.option` : undefined}
        />
      </SheetSurface>
    </SheetModal>
  );
}
