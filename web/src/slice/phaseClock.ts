import { React } from '../runtime';

/**
 * Shared phase for complex fields, so the viewport slice and the 2D slice
 * panel animate together. While playing, every complex field shows
 * Re(E e^{-i phase}) at the clock's phase instead of its own field_phase;
 * when it stops, the panel writes the phase back to the field it shows.
 *
 * One optical period takes PERIOD_MS, whatever the frequency: the animation
 * shows the wave's shape and direction, not its real speed.
 */
export const PERIOD_MS = 2000;

interface PhaseState {
  playing: boolean;
  phase: number; // radians, 0..2pi
}

let state: PhaseState = { playing: false, phase: 0 };
const listeners = new Set<() => void>();
let frame = 0;
let last = 0;

function emit(next: PhaseState): void {
  state = next;
  listeners.forEach((l) => l());
}

function tick(now: number): void {
  if (!state.playing) return;
  const dt = last ? now - last : 0;
  last = now;
  emit({ playing: true, phase: (state.phase + (2 * Math.PI * dt) / PERIOD_MS) % (2 * Math.PI) });
  frame = requestAnimationFrame(tick);
}

export const phaseClock = {
  get: (): PhaseState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  play(from: number): void {
    if (state.playing) return;
    last = 0;
    emit({ playing: true, phase: from });
    frame = requestAnimationFrame(tick);
  },
  /** Stops and returns the phase it stopped at. */
  pause(): number {
    cancelAnimationFrame(frame);
    emit({ playing: false, phase: state.phase });
    return state.phase;
  },
};

export function usePhaseClock(): PhaseState {
  return React.useSyncExternalStore(phaseClock.subscribe, phaseClock.get);
}
