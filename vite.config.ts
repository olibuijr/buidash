import { defineConfig } from 'vite'

// Relative base so the static bundle works at the domain root or any subpath.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2021',
    sourcemap: false,
  },
})
