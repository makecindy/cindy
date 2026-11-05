import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import { useAuth } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { cliProxyManagementBase, type CliProxyQuotaSnapshot } from '../../../shared/cliProxyQuota';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { QuotaBar } from '../status/QuotaBar';

/** Only the local connection's settings view; credentials never leave Main. */
export function CliProxyQuotaSection({ provider }: { provider: ProviderView }) {
  const auth = useAuth();
  const urls = [
    ...new Set(
      Object.values(provider.routing).flatMap((route) => (route?.upstream ? [route.upstream] : [])),
    ),
  ];
  if (provider.source !== 'user' || urls.length !== 1 || !cliProxyManagementBase(urls[0])
    || !window.electronAPI?.maker?.usage?.getCliProxyQuota)
    return null;
  return (
    <QuotaContent
      key={`${auth.dataOwnerId}:${auth.dataOwnerGeneration}:${provider.id}:${urls[0]}`}
      providerId={provider.id}
    />
  );
}

function QuotaContent({ providerId }: { providerId: string }) {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<CliProxyQuotaSnapshot | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const generation = useRef(0);
  const owner = useRef(getDataOwnerGeneration()).current;
  useEffect(() => {
    const epoch = ++generation.current;
    // Read configuration only on open; upstream refresh remains an explicit action.
    window.electronAPI.maker.usage
      .getCliProxyQuota(providerId)
      .then((value) => {
        if (generation.current === epoch && isDataOwnerGenerationCurrent(owner)) setSnapshot(value);
      })
      .catch(() => {
        if (generation.current === epoch && isDataOwnerGenerationCurrent(owner)) setFailed(true);
      });
    return () => {
      generation.current++;
    };
  }, [providerId, owner]);
  async function refresh(managementKey?: string) {
    const epoch = ++generation.current;
    setBusy(true);
    setFailed(false);
    try {
      const value = await window.electronAPI.maker.usage.getCliProxyQuota(
        providerId,
        managementKey,
        true,
      );
      if (generation.current === epoch && isDataOwnerGenerationCurrent(owner)) {
        setSnapshot(value);
        setKey('');
      }
    } catch {
      if (generation.current === epoch && isDataOwnerGenerationCurrent(owner)) {
        setFailed(true);
        setSnapshot((previous) => (previous ? { ...previous, accounts: [], observedAt: 0 } : null));
      }
    } finally {
      if (generation.current === epoch && isDataOwnerGenerationCurrent(owner)) setBusy(false);
    }
  }
  return (
    <section className="border-t px-5 py-4 space-y-3" aria-label={t('cliProxyQuota.title')}>
      <h3 className="text-13 font-medium">{t('cliProxyQuota.title')}</h3>
      {!snapshot?.configured && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void refresh(key);
          }}
        >
          <p className="w-full text-12 text-[var(--text-secondary)]">
            {t('cliProxyQuota.connectHint')}
          </p>
          <Input
            secret
            aria-label={t('cliProxyQuota.key')}
            placeholder={t('cliProxyQuota.key')}
            value={key}
            onChange={setKey}
            disabled={busy}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={busy || !key.trim()}>
            {t('cliProxyQuota.connect')}
          </Button>
        </form>
      )}
      {failed && (
        <p role="alert" className="text-12 text-[var(--text-secondary)]">
          {t('cliProxyQuota.failed')}
        </p>
      )}
      {snapshot?.configured && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void refresh()}>
              {t('cliProxyQuota.refresh')}
            </Button>
            <Button disabled={busy} onClick={() => void refresh('')}>
              {t('cliProxyQuota.disconnect')}
            </Button>
          </div>
          {snapshot.observedAt > 0 && snapshot.accounts.length === 0 && (
            <p className="text-12">{t('cliProxyQuota.empty')}</p>
          )}
          {snapshot.accounts.map((account, index) => (
            <div key={index} className="space-y-2">
              <p className="text-13 font-medium break-all">{account.name}</p>
              {account.disabled ? (
                <p className="text-12">{t('cliProxyQuota.disabled')}</p>
              ) : account.unavailable ? (
                <p className="text-12">{t('cliProxyQuota.unavailable')}</p>
              ) : (
                account.groups.map((group, gi) => (
                  <div key={gi} className="space-y-2">
                    <p className="text-12 text-[var(--text-secondary)]">{group.label}</p>
                    {group.buckets.map((bucket, bi) => (
                      <div key={bi} className="space-y-1">
                        <div className="flex flex-wrap justify-between gap-x-2 text-12">
                          <span>
                            {bucket.window === '5h'
                              ? t('cliProxyQuota.fiveHour')
                              : bucket.window === 'weekly'
                                ? t('cliProxyQuota.weekly')
                                : bucket.label}
                          </span>
                          <span>
                            {bucket.disabled
                              ? t('cliProxyQuota.notApplicable')
                              : bucket.resetTime && Date.parse(bucket.resetTime) <= now
                                ? t('cliProxyQuota.unavailable')
                                : t('cliProxyQuota.remaining', {
                                    percent: Math.round(bucket.remainingFraction * 100),
                                  })}
                          </span>
                        </div>
                        {!bucket.disabled &&
                          (!bucket.resetTime || Date.parse(bucket.resetTime) > now) && (
                            <QuotaBar
                              size="mini"
                              showRemaining
                              usedPercent={(1 - bucket.remainingFraction) * 100}
                              ariaLabel={`${account.name} ${group.label} ${bucket.window}`}
                            />
                          )}
                        {bucket.resetTime && (
                          <p className="text-12 text-[var(--text-tertiary)]">
                            {t('cliProxyQuota.reset', {
                              time: new Date(bucket.resetTime).toLocaleString(
                                i18n.resolvedLanguage,
                              ),
                            })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          ))}
          {snapshot.observedAt > 0 && (
            <p className="text-12 text-[var(--text-tertiary)]">
              {t('cliProxyQuota.updated', {
                time: new Date(snapshot.observedAt).toLocaleString(i18n.resolvedLanguage),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
