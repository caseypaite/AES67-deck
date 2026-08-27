// Shared handle to the single app WebSocket. `useMixerStore` owns the
// connection (and the onmessage dispatch); this lets other stores —
// `useDawStore` in particular — send messages without importing
// `useMixerStore` and creating an import cycle.

let ws: WebSocket | null = null;

export function setWs(next: WebSocket | null): void {
  ws = next;
}

export function wsSend(msg: unknown): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export function wsReady(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
