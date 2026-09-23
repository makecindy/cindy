import { useState } from 'react';
import type { RoutineTrigger } from './companionRoutines';

type CronTrigger = Extract<RoutineTrigger, { kind: 'cron' }>;

/** Keep partial input (including an empty hour/minute) until the user finishes editing. */
export function useRoutineCronFields(trigger: CronTrigger, onChange: (trigger: CronTrigger) => void) {
  const parts = trigger.expression.trim().split(/\s+/);
  const simple = parts.length === 5 && /^\d+$/.test(parts[0]!) && parts[3] === '*';
  const monthly = simple && /^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[2]!) && parts[4] === '*';
  const initial = monthly ? 'monthly' : parts[2] !== '*' ? 'custom' : simple && parts[1] === '*' && parts[4] === '*' ? 'hourly'
    : simple && /^\d+$/.test(parts[1]!) && parts[4] === '*' ? 'daily'
      : simple && /^\d+$/.test(parts[1]!) && parts[4] === '1-5' ? 'weekdays'
        : simple && /^\d+$/.test(parts[1]!) && /^[0-6]$/.test(parts[4]!) ? 'weekly' : 'custom';
  const [preset, setPreset] = useState(initial);
  const [hour, setHour] = useState(simple && parts[1] !== '*' ? parts[1]! : '9');
  const [minute, setMinute] = useState(simple ? parts[0]! : '0');
  const [day, setDay] = useState(initial === 'monthly' ? parts[2]! : initial === 'weekly' ? parts[4]! : '1');
  const update = (mode: string, h: string, m: string, d: string) => {
    if (mode !== 'custom') onChange({ ...trigger, expression: `${m} ${mode === 'hourly' ? '*' : h} ${mode === 'monthly' ? d : '*'} * ${mode === 'weekdays' ? '1-5' : mode === 'weekly' ? d : '*'}` });
  };
  return {
    preset, hour, minute, day,
    changePreset(mode: string) {
      const nextDay = mode === 'monthly' ? String(Math.max(1, Number(day))) : mode === 'weekly' ? String(Math.min(6, Number(day))) : day;
      setDay(nextDay); setPreset(mode); update(mode, hour, minute, nextDay);
    },
    changeHour(value: string) { setHour(value); update(preset, value, minute, day); },
    changeMinute(value: string) { setMinute(value); update(preset, hour, value, day); },
    changeDay(value: string) { setDay(value); update(preset, hour, minute, value); },
  };
}
