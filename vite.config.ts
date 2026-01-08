import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path';
// Fix: Import `fileURLToPath` to define `__dirname` in an ES Module context.
import { fileURLToPath } from 'url';

// Fix: Define `__dirname` which is not available in ES modules by default.
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'background/background.ts'),
        content: resolve(__dirname, 'content.ts'),
      },
      preserveEntrySignatures: false,
      output: {
        entryFileNames: (chunkInfo) => {
            // Keep background and content script names static for the manifest
            if (chunkInfo.name === 'background' || chunkInfo.name === 'content') {
                return '[name].js';
            }
            // Use default hashed names for other assets
            return 'assets/[name]-[hash].js';
        },
        // Use ES modules (service workers support ES modules in Manifest V3)
        format: 'es',
        // Ensure chunks are properly named for extension compatibility
        chunkFileNames: 'assets/[name]-[hash].js',
        // Force all shared dependencies into separate chunks
        manualChunks: (id) => {
          // Don't split node_modules - bundle everything together for extension scripts
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        },
      }
    },
    // Set to false to disable minification for easier debugging and to prevent variable name collisions
    minify: false,
    // Ensure common chunks are shared properly
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  // This ensures files in the public directory are copied to the dist folder
  publicDir: 'public',
})
