import { describe, expect, it } from 'vitest';
import { checkDestination, type ProxyPolicy } from './net_proxy';

// The filtering proxy's decision for one request (#97). Real connections are covered by the bubblewrap test in
// sandbox.integration.test.ts.
describe('checkDestination', () => {
  const resolve =
    (address: string, local: string | null = null) =>
    async () => ({ address, local });
  const policy = (extra: Partial<ProxyPolicy> = {}): ProxyPolicy => ({
    allowedHosts: 'registry.npmjs.org\nPyPI.org\n93.184.216.34',
    resolve: resolve('104.16.0.1'),
    ...extra,
  });

  it('allows a listed host on 80 or 443 and connects to the address it checked', async () => {
    expect(await checkDestination('registry.npmjs.org', 443, policy())).toEqual({ address: '104.16.0.1' });
    expect(await checkDestination('REGISTRY.npmjs.org.', 80, policy())).toEqual({ address: '104.16.0.1' });
    expect(await checkDestination('pypi.org', 443, policy())).toEqual({ address: '104.16.0.1' });
  });

  it('refuses unlisted hosts, subdomains, other ports and unresolvable names', async () => {
    expect(await checkDestination('evil.example', 443, policy())).toEqual({
      refused: 'evil.example is not on the network allow-list',
    });
    expect(await checkDestination('x.registry.npmjs.org', 443, policy())).toMatchObject({ refused: /allow-list/ });
    expect(await checkDestination('registry.npmjs.org', 22, policy())).toEqual({
      refused: 'port 22 is not allowed (only 80 and 443)',
    });
    const failing = policy({ resolve: async () => Promise.reject(new Error('ENOTFOUND')) });
    expect(await checkDestination('registry.npmjs.org', 443, failing)).toEqual({
      refused: 'registry.npmjs.org did not resolve',
    });
  });

  it('refuses a listed name that resolves to a local address (DNS rebinding)', async () => {
    const rebound = policy({ resolve: resolve('10.0.0.5', '10.0.0.5') });
    expect(await checkDestination('registry.npmjs.org', 443, rebound)).toEqual({
      refused: 'registry.npmjs.org resolves to a local address (10.0.0.5)',
    });
  });

  it('checks IP literals like names, with the real resolver', async () => {
    const real = { allowedHosts: '93.184.216.34\n127.0.0.1\n::1' };
    expect(await checkDestination('93.184.216.34', 443, real)).toEqual({ address: '93.184.216.34' });
    expect(await checkDestination('127.0.0.1', 443, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('[::1]', 443, real)).toMatchObject({ refused: /local address/ });
    expect(await checkDestination('169.254.169.254', 80, real)).toMatchObject({ refused: /allow-list/ });
  });
});
