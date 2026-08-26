// crypto.randomUUID() only exists in a secure context. When the appliance
// UI is served over plain http:// from a LAN IP (not localhost), it's
// undefined and every call throws. crypto.getRandomValues() is available
// everywhere, so fall back to a v4 built from it.
export function uuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = (c ?? ({ getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } } as Crypto)).getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}
