// Isolated Vite build for the Validation Console (no auth/Supabase/Tailwind).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'], alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    target: 'esnext',
    outDir: 'build-validation',
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'validation.html') },
  },
});
