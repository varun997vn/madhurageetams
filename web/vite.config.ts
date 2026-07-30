import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Hardcoded rather than derived from GITHUB_REPOSITORY so `vite preview` reproduces
  // production exactly. The site is served from https://<user>.github.io/madhurageetams/.
  base: '/madhurageetams/',
  plugins: [react()],
  build: {
    target: 'es2022',
    // The encrypted bundles must stay separate files fetched at runtime; inlining any of
    // them would defeat the lazy-shard design.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'] },
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
