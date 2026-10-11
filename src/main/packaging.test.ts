import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { build, dependencies, devDependencies } from '../../package.json';

describe('macOS packaging security', () => {
  it('keeps hardened runtime enabled with only the JIT entitlement for the app and its helpers', () => {
    expect(build.mac.hardenedRuntime).toBe(true);
    for (const path of [build.mac.entitlements, build.mac.entitlementsInherit]) {
      const plist = new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'text/xml');
      const entries = Array.from<Element>(plist.querySelector('plist > dict')!.children);
      expect(entries.map((entry) => [entry.tagName, entry.textContent])).toEqual([
        ['key', 'com.apple.security.cs.allow-jit'],
        ['true', ''],
      ]);
    }
  });
});

describe('app page CSP', () => {
  // The packaged page is a file:// page, for which 'self' matches every local file: a renderer script must not be
  // able to fetch one (#280).
  it('lets the app page make no requests', () => {
    const page = new DOMParser().parseFromString(readFileSync('src/renderer/index.html', 'utf8'), 'text/html');
    const policy = page.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    const directives = new Map(
      policy.split(';').map((part: string) => {
        const [name, ...sources] = part.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
  });
});

describe('packaged dependencies', () => {
  it('packages application output without mutable test logs or scratch files beside it', () => {
    const files = [
      'out/main/index.js',
      'out/preload/index.js',
      'out/renderer/index.html',
      'out/renderer/assets/index.js',
      'out/renderer/assets/font.woff2',
      'out/test.log',
      'out/unit-results.json',
      'out/update-project-map.mjs',
      'out/artifacts/screenshot.png',
    ];
    expect(files.filter((file) => build.files.some((pattern) => matchesGlob(file, pattern)))).toEqual(
      files.slice(0, 5),
    );
    expect(build.electronFuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
  });

  // Production dependencies are packaged with their whole dependency tree; dev dependencies are bundled, so only the
  // code Patch imports ships. As a production dependency the SDK brought express, hono and jose along (#40).
  it('bundles the MCP SDK instead of packaging it', () => {
    expect(dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
    expect(devDependencies).toHaveProperty('@modelcontextprotocol/sdk');
  });
});
