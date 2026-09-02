import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': '/src/shared' } },
  },
  preload: {
    resolve: { alias: { '@shared': '/src/shared' } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': '/src/shared' } },
  },
})
