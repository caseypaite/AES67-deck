import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Bind dev + preview to all interfaces so the appliance's dev UI is
  // reachable from another machine on the LAN (run-dev.sh on a headless box).
  server: { host: true },
  preview: { host: true },
})
