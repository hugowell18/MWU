// Isolated Vite build for the Validation Console (no auth/Supabase/Tailwind).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, process.env.MWU_VALIDATION_BUILD_DIR || 'build-validation');

function copyMethodologyAtlas() {
  return {
    name: 'copy-methodology-atlas',
    closeBundle() {
      fs.copyFileSync(
        path.resolve(__dirname, 'html/MWU Pipeline.html'),
        path.join(outputDir, 'methodology-atlas.html'),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyMethodologyAtlas()],
  resolve: { extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'], alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    target: 'esnext',
    outDir: outputDir,
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'validation.html') },
  },
});
