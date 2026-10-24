// The one place Atomix's Preact components import from (v0.26): Preact and htm (kept in ./vendor/, no build step),
// the hooks Atomix uses, and Atomix's own hooks. Write components with html`…` (htm), not JSX.
import { html, render, h } from './vendor/htm-preact.module.js';
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from './vendor/hooks.module.js';
import { onState } from './state-events.js';
import { state } from './app.js';

export { html, render, h, useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect };

/**
 * A value from the app's state (profile, user, status, prefs…); the component re-renders when it changes.
 *   const name = useAppState((s) => s.profile?.name);
 */
export function useAppState(select) {
  const [value, setValue] = useState(() => select(state));
  const pick = useRef(select);
  pick.current = select;
  useEffect(() => {
    const check = () => {
      const next = pick.current(state);
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    };
    check(); // in case it changed between the first render and this effect
    return onState(check);
  }, []);
  return value;
}
