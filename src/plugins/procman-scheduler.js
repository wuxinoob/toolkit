/** Activation-owned schedule and restart timers; clock rules stay in supervisor. */
import { dueAt, scheduleDelay, shouldRestart } from './procman-supervisor.js';

export function createProfileScheduler({ profiles, lastFired, launch, log, onRestart }) {
  const schedules = new Map();
  const restarts = new Map();
  let disposed = false;

  function clearSchedules() {
    for (const timer of schedules.values()) clearTimeout(timer);
    schedules.clear();
  }

  function arm() {
    if (disposed) return;
    clearSchedules();
    const now = Date.now();
    for (const profile of profiles()) {
      if (!profile.enabled || profile.schedule.kind === 'none') continue;
      const when = dueAt(profile.schedule, now, lastFired.get(profile.id) ?? null);
      const delay = scheduleDelay(when, now);
      if (delay === null) continue;
      schedules.set(profile.id, setTimeout(() => {
        schedules.delete(profile.id);
        const current = profiles().find((p) => p.id === profile.id && p.enabled);
        if (!current) return arm();
        // Long schedules wake at setTimeout's ceiling; keep waiting for the slot.
        if (when - Date.now() > 1_000) return arm();
        // This closure belongs to this activation, including after await.
        launch(current, 'schedule').finally(arm);
      }, delay));
      log?.('profile', `armed "${profile.name}" in ${Math.round(delay / 1000)}s`);
    }
  }

  function maybeRestart(session) {
    const { profileId } = session;
    if (disposed || !profileId || session.stoppedByUser || restarts.has(profileId)) return;
    const profile = profiles().find((p) => p.id === profileId && p.enabled);
    if (!profile) return;
    if (!shouldRestart(profile.restart, session.exitCode, session.attempts)) {
      if (profile.restart.policy !== 'never') {
        log?.('profile', `not restarting "${profile.name}" (attempts ${session.attempts}/${profile.restart.maxRetries})`);
      }
      return;
    }

    const attempt = session.attempts + 1;
    const delay = profile.restart.delayMs;
    log?.('profile', `restart "${profile.name}" in ${delay}ms (attempt ${attempt}/${profile.restart.maxRetries})`);
    onRestart(session, profile, attempt);
    restarts.set(profileId, setTimeout(() => {
      restarts.delete(profileId);
      // Editing or deleting this profile must also affect an already-armed restart.
      const current = profiles().find((p) => p.id === profileId && p.enabled);
      if (!current || session.stoppedByUser || !shouldRestart(current.restart, session.exitCode, session.attempts)) return;
      // The session must own its attempt before an early exit frame arrives.
      launch(current, 'restart', attempt);
    }, Math.max(0, delay)));
  }

  function dispose() {
    disposed = true;
    clearSchedules();
    for (const timer of restarts.values()) clearTimeout(timer);
    restarts.clear();
  }

  return { arm, maybeRestart, dispose, get disposed() { return disposed; } };
}
