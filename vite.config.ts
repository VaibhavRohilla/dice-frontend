import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import * as dotenv from 'dotenv';

// Load dotenv
dotenv.config();

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    define: {
      // Make env variables available in the app via import.meta.env
      'import.meta.env.VITE_APP_TITLE': JSON.stringify(env.VITE_APP_TITLE || 'Jhandi Munda'),
      'import.meta.env.VITE_BACKEND_URL': JSON.stringify(env.VITE_BACKEND_URL || 'http://localhost:3000'),
      'import.meta.env.VITE_CHAT_ID': JSON.stringify(env.VITE_CHAT_ID || '123'),
      'import.meta.env.VITE_ROLL_DURATION': JSON.stringify(env.VITE_ROLL_DURATION || '2500'),
      'import.meta.env.VITE_RESULT_DISPLAY_DURATION': JSON.stringify(env.VITE_RESULT_DISPLAY_DURATION || '5'),
    },
    server: {
      port: 5173,
      open: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});

