/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the SwarmOS API, e.g. https://swarmos-api.onrender.com.
   * Leave unset when the API is same-origin (FastAPI serving the build, or
   * the Vite dev proxy).
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
