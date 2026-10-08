import { promises as dns, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// Addresses that reach this machine, the local network or the cloud metadata service rather than the public internet.
// IPv4 rules also match IPv4-mapped IPv6 addresses (::ffff:127.0.0.1), which BlockList checks against them.
const LOCAL = new BlockList();
LOCAL.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network": 0.0.0.0 reaches the local machine
LOCAL.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, including 169.254.169.254 cloud metadata
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL.addAddress('::', 'ipv6');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6'); // unique local
LOCAL.addSubnet('fe80::', 10, 'ipv6'); // link-local

// URL.hostname keeps the brackets of an IPv6 literal; DNS names may end in a dot.
export function bareHostname(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return bare.replace(/\.$/, '').toLowerCase();
}

export function isLocalAddress(address: string): boolean {
  const bare = bareHostname(address);
  const family = isIP(bare);
  if (family === 0) return false;
  return LOCAL.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

// localhost and its subdomains resolve to loopback by convention (and in Chromium regardless of DNS).
export function isLocalHostname(hostname: string): boolean {
  const bare = bareHostname(hostname);
  return bare === 'localhost' || bare.endsWith('.localhost') || isLocalAddress(bare);
}

export interface Destination {
  // Every address the hostname resolved to; connections go only to these.
  addresses: LookupAddress[];
  // The first local address (or local hostname), shown to the user when asking; null for a public destination.
  local: string | null;
}

// The system resolver, an object so tests can replace it.
export const resolver = {
  lookup: (hostname: string): Promise<LookupAddress[]> => dns.lookup(hostname, { all: true, verbatim: true }),
};

// Resolves a URL hostname once and classifies the result. A name counts as local when any address is local, since
// the connection may use any of them.
export async function resolveDestination(hostname: string): Promise<Destination> {
  const bare = bareHostname(hostname);
  const family = isIP(bare);
  const addresses = family !== 0 ? [{ address: bare, family }] : await resolver.lookup(bare);
  if (addresses.length === 0) throw new Error(`${bare} did not resolve to any address.`);
  const local = isLocalHostname(bare)
    ? bare
    : (addresses.find((entry) => isLocalAddress(entry.address))?.address ?? null);
  return { addresses, local };
}

// One resolution per tool call, shared by its mustAsk check, preview and run (they receive the same input object), so
// the request connects to exactly the addresses that were checked and approved even if DNS answers differently later.
const checked = new WeakMap<object, Promise<Destination>>();

export function destinationFor(call: object, hostname: string): Promise<Destination> {
  let pending = checked.get(call);
  if (!pending) {
    pending = resolveDestination(hostname);
    // Whoever awaits it handles a failure; this only keeps an unawaited rejection from being reported as unhandled.
    pending.catch(() => {});
    checked.set(call, pending);
  }
  return pending;
}
