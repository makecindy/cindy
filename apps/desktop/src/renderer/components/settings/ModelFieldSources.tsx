import { useTranslation } from 'react-i18next';
import { modelNewRouteBlockReason, type CatalogModel } from '@cindy/model-providers';
export function ModelFieldSources({
  model,
  contextLimit,
  visible,
  connected,
  suspended,
  userProvider,
}: {
  model: CatalogModel;
  contextLimit: number | null;
  visible: boolean;
  connected: boolean;
  suspended: boolean;
  userProvider: boolean;
}) {
  const { t } = useTranslation();
  const reason = !connected
    ? 'disconnected'
    : suspended
      ? 'suspended'
      : modelNewRouteBlockReason(model, { userProvider });
  const sources = { ...model.fieldSources };
  if (contextLimit !== null)
    sources.contextWindow = [
      ...(sources.contextWindow ?? []),
      { source: 'user', value: contextLimit },
    ];
  const fields = [
    'name',
    'presentation',
    'mode',
    'modalities',
    'group',
    'officialDocs',
    'description',
    'contextWindow',
    'maxOutputTokens',
    'efforts',
    'defaultEffort',
    'supportsFastMode',
    'supportsImageInput',
    'defaultFast',
    'defaultEnabled',
    'preferredAgent',
  ];
  const label = (field: string) =>
    t(`settings.providers.models.advanced.provenance.fields.${field}`);
  const display = (value: unknown) =>
    value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return (
    <details className="mb-4 text-12 text-[var(--text-secondary)]">
      <summary className="cursor-pointer py-2">
        {t('settings.providers.models.advanced.provenance.title')}
      </summary>
      <p className="my-2">{t('settings.providers.models.advanced.provenance.hint')}</p>
      {reason && (
        <p className="my-2">
          {t(`settings.providers.models.advanced.provenance.reasons.${reason}`)}
        </p>
      )}
      {!visible && (
        <p className="my-2">{t('settings.providers.models.advanced.provenance.reasons.hidden')}</p>
      )}
      {!Object.keys(sources).length && (
        <p className="my-2">{t('settings.providers.models.advanced.provenance.noTrace')}</p>
      )}
      <dl className="space-y-2">
        {fields
          .filter((field) => sources[field]?.length)
          .map((field) => (
            <div key={field}>
              <dt className="text-[var(--text-primary)]">{label(field)}</dt>
              <dd className="break-words">
                {sources[field].map((record, index) => (
                  <span key={index}>
                    {index ? ' → ' : ''}
                    {t(
                      `settings.providers.models.advanced.provenance.sources.${record.source}`,
                    )}: {display(record.value)}
                    {record.reason
                      ? ` (${record.reason}${record.verifiedAt ? ` · ${record.verifiedAt}` : ''})`
                      : ''}
                  </span>
                ))}
              </dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
