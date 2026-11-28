import { AppState } from 'react-native';
import { BACKGROUND_STOP_GRACE_MS } from './backgroundConnection';

/** Keep a live transport through interruptions. iOS may suspend JS before the timer runs. */
export function observeTransportAppState(
  setAvailable: (available: boolean) => void,
  backgroundGraceMs = BACKGROUND_STOP_GRACE_MS,
) {
  let deadline: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function expire() {
    clearTimeout(timer);
    timer = undefined;
    deadline = undefined;
    setAvailable(false);
  }
  function change(state: string) {
    if (state === 'inactive') return;
    if (state === 'background') {
      if (backgroundGraceMs === 0) { expire(); return; }
      if (deadline === undefined) {
        deadline = Date.now() + backgroundGraceMs;
        timer = setTimeout(expire, backgroundGraceMs);
      }
    } else if (state === 'active') {
      if (deadline !== undefined && Date.now() >= deadline) expire();
      clearTimeout(timer);
      deadline = undefined;
      setAvailable(true);
    } else {
      expire();
    }
  }
  const subscription = AppState.addEventListener('change', change);
  if (AppState.currentState) change(AppState.currentState);
  return () => { subscription.remove(); clearTimeout(timer); };
}
