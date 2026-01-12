import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { OutputBundle, NormalizedOutputOptions, OutputChunk } from 'rollup';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Helper function to strip ES module syntax from code
function stripEsModuleSyntax(code: string): string {
  // Remove import statements
  code = code.replace(/import\s+\{[^}]+\}\s+from\s+["'][^"']+["'];?\n?/g, '');
  code = code.replace(/import\s+["'][^"']+["'];?\n?/g, '');
  code = code.replace(/import\s+\*\s+as\s+\w+\s+from\s+["'][^"']+["'];?\n?/g, '');
  code = code.replace(/import\s+\w+\s+from\s+["'][^"']+["'];?\n?/g, '');

  // Remove export statements (but keep the variable declarations)
  // Replace "export { ... };" with empty string
  code = code.replace(/export\s*\{[^}]*\};?\n?/g, '');
  // Replace "export default ..." - less common in chunks
  code = code.replace(/export\s+default\s+/g, '');
  // Replace "export const ..." with "const ..."
  code = code.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');

  return code;
}

// Custom plugin to bundle content.js dependencies inline
function inlineContentDeps(): Plugin {
  return {
    name: 'inline-content-deps',
    generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle) {
      // Find content.js and its dependencies
      const contentBundle = bundle['content.js'] as OutputChunk | undefined;
      if (contentBundle && contentBundle.type === 'chunk') {
        // Get all imported modules
        const imports = contentBundle.imports || [];
        let inlinedCode = '';

        // Inline each import
        for (const importPath of imports) {
          const importBundle = bundle[importPath] as OutputChunk | undefined;
          if (importBundle && importBundle.type === 'chunk') {
            // Strip ES module syntax from the imported chunk
            const cleanedCode = stripEsModuleSyntax(importBundle.code);
            inlinedCode += cleanedCode + '\n';
          }
        }

        // Replace imports with inlined code in content.js
        if (inlinedCode) {
          let code = contentBundle.code;
          // Strip ES module syntax from content.js itself
          code = stripEsModuleSyntax(code);
          contentBundle.code = inlinedCode + code;
          contentBundle.imports = [];
        }
      }
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), inlineContentDeps()],
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
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content') {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        format: 'es',
        manualChunks: undefined,
      }
    },
    minify: false,
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  publicDir: 'public',
})
