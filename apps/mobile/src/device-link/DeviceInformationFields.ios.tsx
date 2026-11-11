import { LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { useTranslation } from 'react-i18next';

export function DeviceInformationFields({ fields }: { fields: string[][] }) {
  const { t } = useTranslation();
  return (
    <Section>
      {fields.map(([key, value]) => (
        <LabeledContent key={key} label={t(`devices.management.fields.${key}`)}>
          <Text>{value}</Text>
        </LabeledContent>
      ))}
    </Section>
  );
}
