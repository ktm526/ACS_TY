import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'


// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // src 폴더를 @ 로 참조하도록 설정
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
