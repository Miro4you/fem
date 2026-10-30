import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri erwartet einen festen Port
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5191, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari16', sourcemap: false, chunkSizeWarningLimit: 1500 },
})
