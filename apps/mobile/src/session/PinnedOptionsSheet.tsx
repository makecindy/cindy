import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HomePinnedSort, HomePinnedView } from './homeDisplaySettings';
import { HomeSectionOptionsSheet, type HomeSectionOptionsGroup } from './HomeSectionOptionsSheet';

const PINNED_VIEWS: readonly HomePinnedView[] = ['text', 'list', 'card'];
const PINNED_SORTS: readonly HomePinnedSort[] = ['manual', 'activity'];

export interface PinnedOptionsSheetProps {
  visible: boolean;
  pinnedView: HomePinnedView;
  pinnedSort: HomePinnedSort;
  onChangeView(view: HomePinnedView): void;
  onChangeSort(sort: HomePinnedSort): void;
  onClose(): void;
}

/** Options sheet for pinned section display and sorting preferences. */
export function PinnedOptionsSheet({
  visible,
  pinnedView,
  pinnedSort,
  onChangeView,
  onChangeSort,
  onClose,
}: PinnedOptionsSheetProps) {
  const { t } = useTranslation();
  const sections = useMemo<readonly HomeSectionOptionsGroup[]>(() => [
    {
      id: 'display',
      title: t('devices.list.menu.displayHeading'),
      items: PINNED_VIEWS.map((mode) => ({
        id: mode,
        title: t(`devices.list.menu.view.${mode}`),
        selected: pinnedView === mode,
        testID: `home.pinnedOptions.view.${mode}`,
        onPress: () => onChangeView(mode),
      })),
    },
    {
      id: 'sort',
      title: t('devices.list.menu.sortHeading'),
      footer: pinnedSort === 'manual' ? t('devices.list.menu.pinnedOrderManualTip') : undefined,
      items: PINNED_SORTS.map((sort) => ({
        id: sort,
        title: t(sort === 'manual' ? 'devices.list.menu.projectOrder.custom' : 'devices.list.menu.sortBy.recency'),
        selected: pinnedSort === sort,
        testID: `home.pinnedOptions.sort.${sort}`,
        onPress: () => onChangeSort(sort),
      })),
    },
  ], [onChangeSort, onChangeView, pinnedSort, pinnedView, t]);

  return (
    <HomeSectionOptionsSheet
      visible={visible}
      title={t('session.row.pinnedSection')}
      sections={sections}
      testID="home.pinnedOptionsSheet"
      onClose={onClose}
    />
  );
}
