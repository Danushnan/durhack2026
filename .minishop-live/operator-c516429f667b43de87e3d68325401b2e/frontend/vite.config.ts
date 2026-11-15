import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {proxy: {
    '/api/demo': {target:'http://127.0.0.1:8090', changeOrigin:true},
    '/api/products': {target: 'http://127.0.0.1:8001', rewrite: p => p.replace(/^\/api/, ''), headers: {'X-Source-Service': 'minishop-web'}},
    '/api/carts': {target: 'http://127.0.0.1:8002', rewrite: p => p.replace(/^\/api/, ''), headers: {'X-Source-Service': 'minishop-web'}},
    '/api/checkout': {target: 'http://127.0.0.1:8003', rewrite: p => p.replace(/^\/api/, ''), headers: {'X-Source-Service': 'minishop-web'}},
    '/api/orders': {target: 'http://127.0.0.1:8003', rewrite: p => p.replace(/^\/api/, ''), headers: {'X-Source-Service': 'minishop-web'}}
  }}
});
