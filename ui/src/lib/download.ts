// Client-side file download. The UI is a plain SPA (Vite dev server / nginx on
// the appliance), so a Blob + object URL + transient <a download> is the way to
// hand the operator a file — there is no HTTP endpoint that serves these.
export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has definitely been processed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// A filesystem-safe timestamp for generated filenames, e.g. 2026-08-28-19-04-11.
export function tsSlug(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

// Quote a value for CSV if it contains a comma, quote or newline.
export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
