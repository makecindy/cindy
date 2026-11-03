import { ListItem, Text } from '@expo/ui';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';

/** 与 iOS LabeledContent 一致:字段标签在左、值在右(次要字色、右对齐)。 */
export function DeviceInformationFields({ fields }: { fields: string[][] }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <>
      {fields.map(([key, value]) => (
        <ListItem
          key={key}
          testID={`deviceInformation.field.${key}`}
          trailing={
            <Text textStyle={{ color: colors.textSecondary, textAlign: 'right' }}>
              {value}
            </Text>
          }
        >
          {t(`devices.management.fields.${key}`)}
        </ListItem>
      ))}
    </>
  );
}
