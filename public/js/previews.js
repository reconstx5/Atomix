// Which tile of the seek-bar preview sheets shows moment `t` (seconds). Pure, so
// it runs in the browser and in the Node tests.
export function tileFor(p, t) {
  if (!p || !(p.count > 0)) return null;
  const index = Math.min(p.count - 1, Math.max(0, Math.round((Number(t) || 0) / p.interval)));
  const perSheet = p.columns * p.rows;
  const inSheet = index % perSheet;
  return {
    url: p.url.replace('{n}', String(Math.floor(index / perSheet) + 1)),
    x: (inSheet % p.columns) * p.width,
    y: Math.floor(inSheet / p.columns) * p.height,
    width: p.width,
    height: p.height,
    sheetWidth: p.columns * p.width,
    sheetHeight: p.rows * p.height,
  };
}
