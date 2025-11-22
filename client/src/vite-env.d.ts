/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_PROTOCOL: string
  readonly VITE_WS_HOST: string
  readonly VITE_WS_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
