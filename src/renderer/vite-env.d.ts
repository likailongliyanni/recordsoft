/// <reference types="vite/client" />

import type { ProjetXApi } from '../preload';

declare global {
  interface Window {
    projetX: ProjetXApi;
  }
}
