// The app state's change events (v0.26): components (useAppState in ui.js) re-render when the state they read
// changes. watchState wraps app.js's `state`, so every top-level write is seen wherever it happens; notifyState is
// for nested changes the wrapper can't see (a profile's prefs changed in place). No DOM: tested in Node.
const listeners = new Set();

/** Listen for state changes: fn(key). Returns the unsubscribe. */
export function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tell listeners `key` changed (for changes inside a value, which the wrapper can't see). */
export function notifyState(key) {
  for (const fn of [...listeners]) {
    try {
      fn(key);
    } catch (err) {
      console.error(err);
    }
  }
}

/** The state object, wrapped so that setting a top-level key to a different value notifies. */
export function watchState(target) {
  return new Proxy(target, {
    set(obj, key, value) {
      const changed = !Object.is(obj[key], value);
      obj[key] = value;
      if (changed) notifyState(String(key));
      return true;
    },
  });
}
