// Isolated Vite build for the Validation Console (no auth/Supabase/Tailwind).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function copyMethodologyAtlas() {
  return {
    name: 'copy-methodology-atlas',
    closeBundle() {
      fs.copyFileSync(
        path.resolve(__dirname, 'html/MWU Pipeline.html'),
        path.resolve(__dirname, 'build-validation/methodology-atlas.html'),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyMethodologyAtlas()],
  resolve: { extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'], alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    target: 'esnext',
    outDir: 'build-validation',
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'validation.html') },
  },
});
