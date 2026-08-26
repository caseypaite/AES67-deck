/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the engine/server WebSocket URL (default: ws://<page-host>:8081). */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
