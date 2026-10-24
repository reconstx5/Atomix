// Installing Atomix as an app (v0.21): the offline helper, registered on a secure address, and the browser's own
// install prompt, kept so Settings can offer it.
import { api } from '../api.js';

let deferred = null;
const listeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // offered from Settings → Profile instead of the browser's own bar
    deferred = e;
    for (const fn of listeners) fn();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    for (const fn of listeners) fn();
  });
}

export const secure = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator;
export const installed = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);

/** The helper's address carries the shell's version, so a new Atomix installs a new helper (which waits its turn). */
export async function registerWorker() {
  if (!secure()) return null;
  try {
    const { version } = await api.get('/api/shell');
    return await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: '/' });
  } catch {
    return null; // offline, or the browser refused: the app works as before
  }
}

export function installPrompt() {
  return {
    get available() {
      return Boolean(deferred);
    },
    async prompt() {
      if (!deferred) return 'dismissed';
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      return outcome;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
