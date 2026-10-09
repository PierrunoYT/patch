import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bareHostname,
  destinationFor,
  isLocalAddress,
  isLocalHostname,
  resolveDestination,
  resolver,
} from './net_address';

describe('isLocalAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'this network'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8 end'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12 end'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT end'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['[::1]', 'bracketed IPv6 loopback'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local fd'],
    ['fe80::1', 'IPv6 link-local'],
    ['febf::1', 'IPv6 link-local end'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['[::ffff:7f00:1]', 'IPv4-mapped loopback, hex form'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:10.1.2.3', 'IPv4-mapped private'],
    // #252: special-purpose ranges and IPv4 addresses inside NAT64, 6to4 and IPv4-compatible IPv6 addresses.
    ['192.0.0.192', 'Oracle Cloud metadata (192.0.0.0/24)'],
    ['198.18.0.1', 'benchmarking 198.18/15'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['fec0::1', 'IPv6 site-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of the cloud metadata address'],
    ['64:ff9b::10.0.0.1', 'NAT64 of a private address, dotted form'],
    ['64:ff9b:1::1', 'NAT64 for local use'],
    ['::7f00:1', 'IPv4-compatible 127.0.0.1'],
    ['2002:7f00:1::1', '6to4 of 127.0.0.1'],
    ['[2002:a9fe:a9fe::]', '6to4 of the cloud metadata address, bracketed'],
  ])('%s is local (%s)', (address) => {
    expect(isLocalAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['93.184.216.34', 'public IPv4'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.0', 'just above 172.16/12'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.0', 'just above CGNAT'],
    ['169.253.255.255', 'just below link-local'],
    ['192.169.0.1', 'just above 192.168/16'],
    ['11.0.0.1', 'just above 10/8'],
    ['2606:4700::1111', 'public IPv6'],
    ['fe00::1', 'just below fe80::/10'],
    ['fbff::1', 'just below fc00::/7'],
    ['::ffff:8.8.8.8', 'IPv4-mapped public'],
    ['64:ff9b::808:808', 'NAT64 of a public address (DNS64 networks reach every IPv4 site this way)'],
    ['2002:808:808::1', '6to4 of a public address'],
    ['223.255.255.255', 'just below multicast'],
    ['198.20.0.1', 'just above 198.18/15'],
    ['example.com', 'a name is not an address'],
    ['localhost', 'a name is not an address'],
  ])('%s is not local (%s)', (address) => {
    expect(isLocalAddress(address)).toBe(false);
  });
});

describe('isLocalHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost', '127.0.0.1', '[::1]'])(
    '%s is local',
    (hostname) => {
      expect(isLocalHostname(hostname)).toBe(true);
    },
  );

  it.each(['example.com', 'localhost.example.com', 'notlocalhost', 'mylocalhost', '8.8.8.8'])(
    '%s is not local',
    (hostname) => {
      expect(isLocalHostname(hostname)).toBe(false);
    },
  );

  it('strips brackets and a trailing dot', () => {
    expect(bareHostname('[::1]')).toBe('::1');
    expect(bareHostname('Example.COM.')).toBe('example.com');
  });
});

describe('resolveDestination', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses an address literal without asking DNS', async () => {
    const lookup = vi.spyOn(resolver, 'lookup');
    expect(await resolveDestination('169.254.169.254')).toEqual({
      addresses: [{ address: '169.254.169.254', family: 4 }],
      local: '169.254.169.254',
    });
    expect(await resolveDestination('[::ffff:127.0.0.1]')).toMatchObject({ local: '::ffff:127.0.0.1' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('treats a public-looking name that resolves to loopback as local', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await resolveDestination('rebind.example')).toMatchObject({ local: '127.0.0.1' });
  });

  it('treats a name as local when any of its addresses is', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    expect(await resolveDestination('mixed.example')).toMatchObject({ local: '10.0.0.5' });
  });

  it('treats localhost names as local whatever they resolve to', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await resolveDestination('app.localhost')).toMatchObject({ local: 'app.localhost' });
  });

  it('leaves a public name public', async () => {
    vi.spyOn(resolver, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await resolveDestination('example.com')).toEqual({
      addresses: [{ address: '93.184.216.34', family: 4 }],
      local: null,
    });
  });

  it('resolves once per tool call', async () => {
    const lookup = vi
      .spyOn(resolver, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const call = { url: 'https://rebind.example/' };
    const first = await destinationFor(call, 'rebind.example');
    const second = await destinationFor(call, 'rebind.example');
    expect(second).toBe(first);
    expect(second.local).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await destinationFor({ ...call }, 'rebind.example')).local).toBe('127.0.0.1');
  });
});
