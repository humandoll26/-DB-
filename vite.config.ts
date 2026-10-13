import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist' },
  server: { host: '127.0.0.1', fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/operations.sqlite*', '**/instance.lock', '**/demo.json', '**/*.pdf', '**/server/**', '**/scripts/**', '**/assets/fonts/**'] } },
});
