import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'


// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/', // 기본 경로를 루트로 설정
  build: {
    outDir: '../server/dist', // 서버의 dist 폴더로 빌드
    emptyOutDir: true, // 빌드 전 폴더 비우기
  },
  resolve: {
    alias: {
      // src 폴더를 @ 로 참조하도록 설정
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
