import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The Rust BFF owns all authentication and billing endpoints in development too. */
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/auth': 'http://127.0.0.1:8787' } },
});
