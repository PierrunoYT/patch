import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'coverage/', '**/*.tsbuildinfo'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // The renderer is sandboxed and has no Node. Flat config merges globals rather than replacing them, and
    // typescript-eslint turns off `no-undef` for TypeScript, so restrict the Node names directly.
    files: ['src/renderer/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'process', 'require', 'module', '__dirname', '__filename', 'Buffer', 'global'],
    },
  },
  {
    // The project map is classic browser scripts loaded in order by project-map/index.html (modules do not load from
    // file://). data.js and core.js define the shared top-level names the views and boot.js use.
    files: ['project-map/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        $: 'readonly',
        D: 'readonly',
        RENDERER_CSS_LINES: 'readonly',
        procLines: 'readonly',
        NS: 'readonly',
        s: 'readonly',
        h: 'readonly',
        fmt: 'readonly',
        procColor: 'readonly',
        card: 'readonly',
        bars: 'readonly',
        TABS: 'readonly',
        builders: 'readonly',
        showTab: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Test code, mock servers, the e2e harness and the perf measurements are allowed to reach for `any`;
    // production sources are not.
    files: ['**/*.test.ts', 'tests/e2e/**', 'tests/perf/**', 'src/main/llm/test_server.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'off',
    },
  },
  {
    rules: {
      // `_`-prefixed bindings signal deliberate omission (e.g. the destructure-to-drop idiom).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // These define the project map's shared names, which only the other scripts use. After the rule above.
    files: ['project-map/data.js', 'project-map/core.js'],
    rules: { 'no-redeclare': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
);
