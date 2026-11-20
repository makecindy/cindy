import { ActivityIndicator, Keyboard, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { giftCardCodeRegion, type GiftCard } from '@cindy/maker-shared/gift-card';
import { giftCardAmountLabel } from '@cindy/maker-shared/gift-card-amount';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { formatPresentationDate } from '@/i18n/dateFormatters';
import { CompanionSheet } from '@/session/CompanionSheet';
import { monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { GiftCardFace, giftCardFaceShowsAmount } from './GiftCardFace';
import { useGiftCardRedeem, type GiftCardProblem } from './useGiftCardRedeem';

export interface GiftCardSheetProps {
  visible: boolean;
  /** 链接带来的兑换码；手动打开时没有。 */
  code?: string;
  invalidLink?: boolean;
  onClose(): void;
  onClosed?(): void;
  onBusyChange?(busy: boolean): void;
}

const PROBLEM_KEYS: Record<Exclude<GiftCardProblem['reason'], 'WRONG_REGION'>, string> = {
  INVALID: 'giftCard.errors.notFound',
  NOT_FOUND: 'giftCard.errors.notFound',
  ALREADY_CLAIMED: 'giftCard.errors.alreadyClaimed',
  EXPIRED: 'giftCard.errors.expired',
  VOIDED: 'giftCard.errors.voided',
  RATE_LIMITED: 'giftCard.errors.rateLimited',
  PERSONAL_REQUIRED: 'giftCard.errors.personalRequired',
  FAILED: 'giftCard.errors.failed',
};

/** 兑换礼品卡的底部面板：输入兑换码 → 看到这张卡 → 确认领取 → 到账。 */
export function GiftCardSheet({ visible, code, invalidLink, onClose, onClosed, onBusyChange }: GiftCardSheetProps) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const model = useGiftCardRedeem({ visible, code, invalidLink, onBusyChange });
  const { step, problem } = model;
  // 面额按账号所在区域的计费币种计量，与余额同口径。
  const currency = model.realm === 'cn' ? 'CNY' : 'USD';
  const amountOf = (amount: string) => giftCardAmountLabel(amount, currency) ?? amount;
  const dateOf = (value: string) => formatPresentationDate(new Date(value), i18n.language);
  const redeeming = step.kind === 'redeeming';
  const close = () => { if (!redeeming) { Keyboard.dismiss(); onClose(); } };

  const problemText = !problem ? null
    : problem.reason === 'WRONG_REGION'
      ? t((problem.code ? giftCardCodeRegion(problem.code) : null) === 'cn' ? 'giftCard.errors.wrongRegionCn' : 'giftCard.errors.wrongRegionGlobal')
      : problem.reason === 'VOIDED' && problem.purchased ? t('giftCard.errors.voidedPurchased')
      : t(PROBLEM_KEYS[problem.reason]);

  const title = step.kind === 'confirm' || step.kind === 'redeeming' ? t('giftCard.confirmTitle')
    : step.kind !== 'done' ? t('giftCard.title')
    : step.credit?.state === 'APPLIED' ? t('giftCard.doneTitle', { amount: amountOf(step.credit.amount) })
    : t('giftCard.pendingTitle');

  // 用户自己买的卡进充值余额、永久有效；后台发的卡进赠送余额、到期失效。
  const purchased = step.kind === 'done' && step.card.destination === 'PURCHASED';
  const doneDescription = step.kind !== 'done' ? null
    : step.credit === null ? t('giftCard.alreadyYours')
    : step.credit.state === 'PENDING'
      ? t(purchased ? 'giftCard.pendingDescriptionPurchased' : 'giftCard.pendingDescription', { amount: amountOf(step.credit.amount) })
    : purchased ? t('giftCard.doneDescriptionPurchased')
    : step.credit.expiresAt ? t('giftCard.doneDescription', { date: dateOf(step.credit.expiresAt) })
    : t('giftCard.doneDescriptionNoDate');

  const primary = step.kind === 'done'
    ? { label: t('giftCard.done'), onPress: close }
    : step.kind === 'confirm' || step.kind === 'redeeming'
      ? { label: t('giftCard.confirmAction'), busy: redeeming, onPress: model.redeem }
      : { label: t('giftCard.continue'), busy: step.kind === 'reading', disabled: !model.input.trim(), onPress: () => { Keyboard.dismiss(); model.submit(); } };

  const card = (value: GiftCard) => {
    const printed = giftCardFaceShowsAmount(value.faceCode, value.amount, currency);
    return <View style={styles.hero}>
      <GiftCardFace faceCode={value.faceCode} amount={value.amount} currency={currency}
        label={t('giftCard.cardLabel', { amount: amountOf(value.amount) })} testID="giftCard.face" />
      <View style={styles.heroTexts}>
        {/* 金额印不上卡面时（本版本没有的字符）退回普通文字。 */}
        {!printed ? <Text style={styles.amount}>{amountOf(value.amount)}</Text> : null}
        <Text style={styles.centeredNote}>{t('giftCard.from', { sender: value.senderName })}</Text>
        {value.message ? <Text style={styles.message}>{value.message}</Text> : null}
      </View>
    </View>;
  };

  return <CompanionSheet visible={visible} title={title} contentScrolls initialSnap="full" onClose={close} onClosed={onClosed}
    preventDismiss={redeeming} testID="giftCard.sheet" footer={<View style={styles.footer}>
      <MainWindowActionButton grow action={{ ...primary, tone: 'primary', testID: 'giftCard.primary' }} />
      {step.kind !== 'done' ? <MainWindowActionButton grow action={{ label: t('giftCard.close'), disabled: redeeming, onPress: close, testID: 'giftCard.close' }} /> : null}
    </View>}>
    <View style={styles.content}>
      {step.kind === 'input' || step.kind === 'reading' ? <>
        <Text style={styles.note}>{t('giftCard.inputHint')}</Text>
        <TextInput accessibilityLabel={t('giftCard.inputLabel')} placeholder="XXXX-XXXX-XXXX-XXXX" placeholderTextColor={colors.textPlaceholder}
          value={model.input} onChangeText={model.setInput} editable={step.kind === 'input'}
          autoCapitalize="characters" autoCorrect={false} spellCheck={false} autoComplete="off" maxLength={512}
          returnKeyType="go" onSubmitEditing={() => { Keyboard.dismiss(); model.submit(); }} style={styles.input} testID="giftCard.input" />
        {step.kind === 'reading' ? <ActivityIndicator accessibilityLabel={t('giftCard.title')} color={colors.textSecondary} /> : null}
      </> : null}
      {step.kind === 'confirm' || step.kind === 'redeeming' ? <>
        {card(step.card)}
        {step.card.destination === 'PURCHASED' ? <View style={styles.box}>
          <TermRow label={t('giftCard.fields.destination')} value={t('giftCard.fields.destinationPurchased')} />
          <TermRow separated label={t('giftCard.fields.validity')} value={t('giftCard.fields.validityPermanent')} />
        </View> : <View style={styles.box}>
          {step.card.validityDays !== null ? <TermRow label={t('giftCard.fields.validity')} value={t('giftCard.fields.validityValue', { count: step.card.validityDays })} /> : null}
          {step.card.claimDeadline !== null ? <TermRow separated={step.card.validityDays !== null} label={t('giftCard.fields.claimBy')} value={dateOf(step.card.claimDeadline)} /> : null}
          <TermRow separated label={t('giftCard.fields.destination')} value={t('giftCard.fields.destinationValue')} />
        </View>}
      </> : null}
      {step.kind === 'done' ? <>
        {card(step.card)}
        {doneDescription ? <Text style={styles.centeredNote} testID="giftCard.result">{doneDescription}</Text> : null}
      </> : null}
      {problemText ? <Text accessibilityRole="alert" style={styles.problem} testID="giftCard.problem">{problemText}</Text> : null}
    </View>
  </CompanionSheet>;
}

function TermRow({ label, value, separated = false }: { label: string; value: string; separated?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.row, separated && styles.separator]}>
    <Text style={styles.rowLabel}>{label}</Text>
    <Text style={styles.rowValue}>{value}</Text>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.lg, paddingTop: spacing.sm },
  footer: { gap: spacing.sm },
  hero: { gap: spacing.md },
  heroTexts: { gap: spacing.xs },
  amount: { textAlign: 'center', fontSize: typeScale.headline, lineHeight: lineHeight.headline, fontWeight: fontWeight.semibold, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  centeredNote: { textAlign: 'center', fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  message: { textAlign: 'center', fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textPrimary },
  problem: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.errorText },
  input: { minHeight: 50, borderRadius: radius.pill, paddingHorizontal: spacing.lg, fontFamily: monoFont, fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular,
    color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  box: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border, borderRadius: radius.container, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowLabel: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  rowValue: { flexShrink: 1, textAlign: 'right', fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: colors.textSecondary },
});
