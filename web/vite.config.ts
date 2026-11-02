import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into web/dist, which the Node server serves at /.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
