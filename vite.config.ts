import { defineConfig } from 'vite';
export default defineConfig({ root: 'web', build: { outDir: '../dist', emptyOutDir: true, minify: false }, server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4310' } }, esbuild: { jsx: 'automatic' } });
