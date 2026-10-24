// Whether to animate: the system setting, or the profile's own "Reduce motion" (html.reduce-motion).
export function reduceMotion() {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('reduce-motion')) return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
