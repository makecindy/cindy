/**
 * useTodaySpend — 订阅"今日用量"实时数据 (走 maker.usage.* IPC)。
 *
 * 数据来源:
 *   1. mount 时分别调 maker:usage:today('claude-code') / ('codex') 拉一次
 *   2. 订阅 maker.usage.onTodaySpendChanged (Claude USD) + onTodayTokensChanged (Codex token)
 *   3. 每分钟检查本地日期是否变化(午夜 0:00 跨日时主动重拉)
 *
 * 返回 shape: { day, costUsd, codexTokens }
 *   costUsd:    null = 未加载;number = 当日 Claude 累计 USD (含 0)
 *   codexTokens: null = 未加载;number = 当日 Codex token 总量
 *
 * 历史: 老版本走 electronAPI.getTodaySpend / onUsageTodaySpendChanged + electronAPI.codex.usage.*,
 * codex 元 IPC 升级到 maker.* 后这两条管道都收口在 maker.usage.*。
 */

import { useEffect, useState } from 'react';
import {
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney';

export interface TodaySpendData {
  day: string;
  money: RegionalMoney | null;
  codexTokens: number | null;
}

function localDayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function useTodaySpend(): TodaySpendData {
  const [data, setData] = useState<TodaySpendData>({
    day: localDayKey(),
    money: null,
    codexTokens: null,
  });

  useEffect(() => {
    let cancelled = false;
    let currentDay = localDayKey();

    const refreshClaude = (): void => {
      void window.electronAPI.maker.usage.getToday('claude-code').then((res) => {
        if (cancelled) return;
        currentDay = res.day;
        const money =
          normalizeRegionalMoney(res.money) ??
          (typeof res.costUsd === 'number'
            ? legacyUsdMoney(res.costUsd)
            : null);
        setData((prev) => ({
          day: res.day,
          money: money ?? prev.money,
          codexTokens: prev.codexTokens,
        }));
      });
    };

    const refreshCodex = (): void => {
      void window.electronAPI.maker.usage.getToday('codex').then((res) => {
        if (cancelled) return;
        setData((prev) => ({
          ...prev,
          codexTokens: res.totalTokens ?? prev.codexTokens,
        }));
      });
    };

    // 1. mount 拉一次 Claude USD + Codex token
    refreshClaude();
    refreshCodex();

    // 2. 订阅 Claude USD 实时变化 (per-turn done 后 main 推)
    const unsubscribe = window.electronAPI.maker.usage.onTodaySpendChanged((res) => {
      if (cancelled) return;
      // 只接受"今天"的更新(防御 main 在跨日缝隙推的延迟数据)
      if (res.day === localDayKey()) {
        currentDay = res.day;
        const money =
          normalizeRegionalMoney(res.money) ??
          (typeof res.costUsd === 'number'
            ? legacyUsdMoney(res.costUsd)
            : null);
        setData((prev) => ({
          day: res.day,
          money,
          codexTokens: prev.codexTokens,
        }));
      }
    });

    // 2b. 订阅 Codex token 实时变化
    const unsubscribeCodex = window.electronAPI.maker.usage.onTodayTokensChanged((snapshot) => {
      if (cancelled) return;
      setData((prev) => ({ ...prev, codexTokens: snapshot.total }));
    });

    // 3. 每分钟检查日期是否变化(跨午夜 0:00 主动重拉, 避免显示残留昨天数据)
    const dateCheckInterval = setInterval(() => {
      const newDay = localDayKey();
      if (newDay !== currentDay) {
        currentDay = newDay;
        refreshClaude();
        refreshCodex();
      }
    }, 60_000);

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeCodex();
      clearInterval(dateCheckInterval);
    };
  }, []);

  return data;
}
