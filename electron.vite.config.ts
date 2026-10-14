import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { helperDigest } from './src/main/tools/pe_digest';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

// Digests of the native helpers that `npm run build` compiled just before this, so a packaged build runs only those
// (native_integrity.ts, #149), net-bridge included (#298). Empty where they were not built.
const digests: Record<string, string> = {};
for (const name of ['sandbox-helper.exe', 'file-helper.exe', 'net-bridge.exe', 'net-bridge']) {
  const path = resolve(__dirname, 'native/sandbox-helper/target/release', name);
  const digest = existsSync(path) ? helperDigest(name, readFileSync(path)) : null;
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
    // The app page makes no requests of its own, so its CSP has connect-src 'none': for a file:// page 'self' would
    // match every local file (#280). Only the dev server's page needs a connection, for hot reloading.
    plugins: [
      {
        name: 'patch-dev-connect-src',
        apply: 'serve',
        transformIndexHtml: (html: string) => html.replace("connect-src 'none'", "connect-src 'self'"),
      },
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
