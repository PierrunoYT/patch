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
LOCAL.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments, including Oracle Cloud's 192.0.0.192 metadata
LOCAL.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking, routed inside some networks
LOCAL.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
LOCAL.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, and 255.255.255.255 broadcast
LOCAL.addAddress('::', 'ipv6');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6'); // unique local
LOCAL.addSubnet('fe80::', 10, 'ipv6'); // link-local
LOCAL.addSubnet('fec0::', 10, 'ipv6'); // site-local (deprecated, still routed by some networks)
LOCAL.addSubnet('ff00::', 8, 'ipv6'); // multicast
LOCAL.addSubnet('64:ff9b:1::', 48, 'ipv6'); // NAT64 for local use

// The 16 bytes of an IPv6 address, or null when it is not one.
function ipv6Bytes(address: string): number[] | null {
  let text = address.replace(/%.*$/, '');
  if (isIP(text) !== 6) return null;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const front = groups(head);
  const back = groups(tail);
  const words = tail === undefined ? front : [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

// The IPv4 address inside a NAT64 (64:ff9b::/96), 6to4 (2002::/16) or IPv4-compatible (::/96) address, which
// reaches that IPv4 address: 64:ff9b::7f00:1 is 127.0.0.1 (#252). Null for other addresses.
function embeddedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address);
  if (!bytes) return null;
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  let at = -1;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) at = 12;
  else if (bytes[0] === 0x20 && bytes[1] === 0x02) at = 2;
  else if (zero(0, 12)) at = 12;
  return at < 0 ? null : bytes.slice(at, at + 4).join('.');
}

// URL.hostname keeps the brackets of an IPv6 literal; DNS names may end in a dot.
export function bareHostname(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return bare.replace(/\.$/, '').toLowerCase();
}

export function isLocalAddress(address: string): boolean {
  const bare = bareHostname(address);
  const family = isIP(bare);
  if (family === 0) return false;
  if (family === 6) {
    const ipv4 = embeddedIpv4(bare);
    if (ipv4 !== null && LOCAL.check(ipv4, 'ipv4')) return true;
  }
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
