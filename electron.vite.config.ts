import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { peDigest } from './src/main/tools/pe_digest';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

// Digests of the Windows helpers that `npm run build` compiled just before this, so a packaged build runs only those
// (native_integrity.ts, #149). Empty where they were not built.
const digests: Record<string, string> = {};
for (const name of ['sandbox-helper.exe', 'file-helper.exe']) {
  const path = resolve(__dirname, 'native/sandbox-helper/target/release', name);
  const digest = existsSync(path) ? peDigest(readFileSync(path)) : null;
  if (digest) digests[name] = digest;
}

export default defineConfig({
  main: {
    // Production dependencies stay in node_modules and are packaged with their whole dependency tree. The MCP SDK is
    // a dev dependency instead, so it is bundled: only its client code, which is all Patch imports, ends up in the
    // app, without the SDK's server side (express, hono, jose...).
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    define: { __PATCH_NATIVE_DIGESTS__: JSON.stringify(digests) },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
