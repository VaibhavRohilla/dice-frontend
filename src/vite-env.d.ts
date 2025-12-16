/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  readonly VITE_COUNTDOWN_DURATION: string;
  readonly VITE_ROLL_DURATION: string;
  readonly VITE_RESULT_DISPLAY_DURATION: string;
  readonly VITE_AUTO_START: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

