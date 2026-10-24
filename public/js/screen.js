// Mounting a page (v0.26): a view module either exports render(el, params, query) as before, or a Preact component
// `Screen` taking { params, query, data }. A Screen's module may also export load(params, query): the router waits
// for it (as it waits for an old view's render), so the page is announced, focused and scrolled once its data is
// drawn, and a failed load shows the router's usual "Something went wrong" / "Nothing here" page.
// Preact only runs when a Screen is opened: pages that are still render(el) views don't start it (the page fetches
// its files with the boot, so a first Screen doesn't wait for them; src/http/page.js).
// A route may name the Screen's data module (`data:` in app.js's routes): the router starts its load() at once,
// while the screen's own modules (Preact among them) are still arriving.

/**
 * Mount `mod` into `container`. Resolves (once drawn) to the cleanup for leaving the page, or null. Rejects on failure.
 * `early`: the route's data, already on its way (a route naming a data module starts it with the screen's modules);
 * then the module's load() isn't called again.
 */
export async function mountView(container, mod, params, query, early) {
  if (mod.Screen) {
    const [{ html, render }, data] = await Promise.all([import('./ui.js'), early ?? (mod.load ? mod.load(params, query) : undefined)]);
    try {
      render(html`<${mod.Screen} params=${params} query=${query} data=${data} view=${container} />`, container);
    } catch (err) {
      render(null, container); // nothing half-drawn stays behind
      throw err;
    }
    return () => render(null, container); // unmounting runs every effect's cleanup (useEffect ones a moment later)
  }
  const result = await mod.render(container, params, query);
  return typeof result === 'function' ? result : null;
}
