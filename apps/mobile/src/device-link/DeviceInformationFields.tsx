import { ListItem, Text } from '@expo/ui';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';

export function DeviceInformationFields({ fields }: { fields: string[][] }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <>
      {fields.map(([key, value]) => (
        <ListItem
          key={key}
          supportingText={
            <Text textStyle={{ color: colors.textSecondary }}>{value}</Text>
          }
        >
          {t(`devices.management.fields.${key}`)}
        </ListItem>
      ))}
    </>
  );
}
