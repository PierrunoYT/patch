import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, matchesGlob } from 'node:path';
import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { BUNDLED_IN_MAIN } from '../../electron.vite.config';
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

  // Runtime libraries are production dependencies, so `npm audit --omit=dev` checks them (#305). build.files packages
  // only the ones the main build leaves in node_modules, with their whole dependency tree; the rest are bundled. As a
  // packaged dependency the MCP SDK brought express, hono and jose along (#40).
  it('packages exactly the dependency tree of what the main build leaves in node_modules', () => {
    expect(build.files).toContain('!node_modules/**');
    const packaged = build.files.flatMap((pattern) => /^node_modules\/(.+)\/\*\*$/.exec(pattern)?.[1] ?? []);
    const imported = importedPackages(['src/main', 'src/preload']);
    const external = Object.keys(dependencies).filter((name) => imported.has(name) && !BUNDLED_IN_MAIN.includes(name));
    expect(packaged.sort()).toEqual(dependencyTree(external));
    for (const name of imported) expect([...external, ...BUNDLED_IN_MAIN], name).toContain(name);
    expect(BUNDLED_IN_MAIN).toContain('@modelcontextprotocol/sdk');
    expect(packaged).not.toContain('express');
  });

  it('lists every runtime library as a production dependency', () => {
    for (const name of importedPackages(['src/main', 'src/preload', 'src/renderer'])) {
      expect(Object.keys(devDependencies), name).not.toContain(name);
    }
  });
});

// Packages a non-test source file imports by bare name (Node built-ins, electron and the @shared alias left out).
function importedPackages(roots: string[]): Set<string> {
  const names = new Set<string>();
  for (const root of roots) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|css)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      const specifiers = /\b(?:from|import|require\()\s*\(?['"]((?:@[\w.-]+\/)?\w[\w.-]*)(?:\/[^'"]*)?['"]/g;
      for (const [, name] of text.matchAll(specifiers)) {
        if (!isBuiltin(name!) && name !== 'electron' && !name!.startsWith('@shared/')) names.add(name!);
      }
    }
  }
  return names;
}

// The top-level folders under node_modules that the given packages need at run time, from package-lock.json. A nested
// copy (node_modules/a/node_modules/b) is packaged with its parent's folder.
function dependencyTree(roots: string[]): string[] {
  const packages = (JSON.parse(readFileSync('package-lock.json', 'utf8')) as LockFile).packages;
  const seen = new Set<string>();
  const visit = (name: string, from: string): void => {
    let key = `${from}/node_modules/${name}`.replace(/^\//, '');
    while (!packages[key]) {
      if (!from) throw new Error(`${name} is not in package-lock.json`);
      from = from.slice(0, Math.max(0, from.lastIndexOf('/node_modules/')));
      key = `${from}/node_modules/${name}`.replace(/^\//, '');
    }
    if (seen.has(key)) return;
    seen.add(key);
    const entry = packages[key]!;
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      visit(dependency, key);
    }
  };
  for (const name of roots) visit(name, '');
  return [...new Set([...seen].map((key) => key.split('/node_modules/')[0]!.slice('node_modules/'.length)))].sort();
}

interface LockFile {
  packages: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
}
