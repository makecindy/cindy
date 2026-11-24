import { spacing } from '@/theme/tokens';
import { DatePicker, Text } from '@expo/ui/swift-ui';
import { datePickerStyle, foregroundStyle, listRowInsets } from '@expo/ui/swift-ui/modifiers';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection } from './ComposerNativeSection';
import { ComposerNativeRow } from './ComposerNativeRow';
import { useTaskSnoozeSheet, type TaskSnoozeSheetProps } from './taskSnoozeSheetModel';

export function TaskSnoozeSheet(props: TaskSnoozeSheetProps) {
  const model = useTaskSnoozeSheet(props);
  const { t } = model;
  return <ComposerSheet nativeContent visible={props.visible} onClose={props.onClose} onClosed={props.onClosed}
    title={t('devices.list.menu.inbox.snooze')}
    onBack={model.custom ? () => model.setCustom(false) : undefined} testID="home.snoozeSheet">
    {model.custom ? <ComposerNativeSection>
      <DatePicker selection={model.date ?? model.minimumDate} onDateChange={model.setDate}
        range={{ start: model.minimumDate, end: model.maximumDate }}
        displayedComponents={['date', 'hourAndMinute']} modifiers={[datePickerStyle('compact')]}
        title={t('devices.list.menu.inbox.custom')} testID="home.snoozeDate" />
      <ComposerNativeRow modifiers={[listRowInsets({ top: 0, bottom: 0, leading: spacing.lg, trailing: spacing.lg })]} title={t('devices.common.save')} onPress={() => model.choose(model.date)} testID="home.snoozeConfirm" />
    </ComposerNativeSection> : <>
      <ComposerNativeSection>
        {model.options.map(option => <ComposerNativeRow modifiers={[listRowInsets({ top: 0, bottom: 0, leading: spacing.lg, trailing: spacing.lg })]} key={option.id} title={option.label}
          accessory={<Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{option.time}</Text>}
          onPress={() => model.choose(option.until)} testID={`home.snooze.${option.id}`} />)}
        <ComposerNativeRow modifiers={[listRowInsets({ top: 0, bottom: 0, leading: spacing.lg, trailing: spacing.lg })]} title={t('devices.list.menu.inbox.indefinite')} onPress={model.chooseIndefinite} testID="home.snooze.indefinite" />
      </ComposerNativeSection>
      <ComposerNativeSection>
        <ComposerNativeRow modifiers={[listRowInsets({ top: 0, bottom: 0, leading: spacing.lg, trailing: spacing.lg })]} title={t('devices.list.menu.inbox.custom')} onPress={() => model.setCustom(true)} testID="home.snoozeCustom" />
      </ComposerNativeSection>
    </>}
    {model.invalid && <ComposerNativeSection><Text>{t('devices.list.menu.inbox.invalidTime')}</Text></ComposerNativeSection>}
  </ComposerSheet>;
}
