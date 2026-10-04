// Where API requests go. Keys must only ever reach the official endpoints or the base URL the user set in Settings.
//
// The SDKs fall back to ANTHROPIC_BASE_URL / OPENAI_BASE_URL (and an `ant auth login` profile) when no base URL is
// passed, so the clients always get one of these explicitly (#64).
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const OPENAI_API_URL = 'https://api.openai.com/v1';

// End-to-end and unit tests point the app at local stand-ins through PATCH_TEST_* variables. A packaged app ignores
// them, like ELECTRON_RENDERER_URL (renderer_url.ts, #27): anyone who could set them when starting Patch would
// otherwise receive the user's keys or ChatGPT tokens. Until the main process says otherwise this counts as a
// packaged build, so a missed call fails closed.
let packagedBuild = true;

export function setPackagedBuild(packaged: boolean): void {
  packagedBuild = packaged;
}

export type TestEndpoint =
  'PATCH_TEST_ANTHROPIC_URL' | 'PATCH_TEST_OPENAI_URL' | 'PATCH_TEST_CODEX_URL' | 'PATCH_TEST_CODEX_TOKEN_URL';

// The test stand-in's URL in a development build when the variable is set; otherwise undefined.
export function testEndpoint(name: TestEndpoint): string | undefined {
  if (packagedBuild) return undefined;
  return process.env[name] || undefined;
}
