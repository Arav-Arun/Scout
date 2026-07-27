// connection.ts - the ClickHouse connection Scout is talking to *right now*.
//
// Scout ships with no warehouse of its own: every visitor brings their own ClickHouse and
// links it through the in-app setup tour. The credentials live in one sealed cookie per
// browser (session.ts), so there is no shared server-side state and two people using the
// same deployment never see each other's data.
//
// The connection is carried through the request with an AsyncLocalStorage rather than
// threaded as a parameter through every call site: the whole data layer (clickhouse.ts,
// catalog.ts, lib/graph/*) and the agent pipeline sit under one withConnection() at the
// route boundary and just call currentConnection(). connectionKey() is the cache key every
// per-connection cache in the app is partitioned by.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Everything needed to reach one ClickHouse database. */
export interface Connection {
  /** Normalized origin, e.g. "https://abc.ap-south-1.aws.clickhouse.cloud:8443". */
  url: string;
  username: string;
  password: string;
  database: string;
  /**
   * True when the ClickHouse user is ALREADY pinned read-only server-side (readonly=1),
   * so Scout must not try to send `readonly=2` itself - such a server rejects any settings
   * change outright. Detected during the connection test; see pingConnection().
   */
  readonlyLocked?: boolean;
}

/** Thrown when a request touches the warehouse before the user has linked one. */
export class NotConnectedError extends Error {
  constructor() {
    super("No ClickHouse connection is linked. Connect a database to continue.");
    this.name = "NotConnectedError";
  }
}

export const isNotConnected = (e: unknown): e is NotConnectedError =>
  e instanceof NotConnectedError || (e instanceof Error && e.name === "NotConnectedError");

const store = new AsyncLocalStorage<Connection>();

/** Run `fn` (and everything it awaits) with `conn` as the active connection. */
export function withConnection<T>(conn: Connection, fn: () => T): T {
  return store.run(conn, fn);
}

/** The active connection, or throw NotConnectedError. */
export function currentConnection(): Connection {
  const c = store.getStore();
  if (!c) throw new NotConnectedError();
  return c;
}

/** The active connection, or null when the caller can degrade gracefully. */
export function tryConnection(): Connection | null {
  return store.getStore() ?? null;
}

/**
 * Stable fingerprint of a connection, used to partition every per-connection cache
 * (client pool, catalog, schema graph, column profiles). The password is deliberately
 * excluded: rotating it must not orphan a warm cache, and the key is only ever a map key.
 */
export function connectionKey(conn: Connection = currentConnection()): string {
  return createHash("sha256")
    .update(`${conn.url}\u0000${conn.username}\u0000${conn.database}`)
    .digest("hex")
    .slice(0, 24);
}

/** The active connection's database name. */
export function databaseName(): string {
  return currentConnection().database;
}

// ── Host normalization ───────────────────────────────────────────────────────

/**
 * Turn whatever the user pasted into a canonical origin. Accepts a bare hostname
 * ("abc.clickhouse.cloud"), a host:port pair, or a full URL, and defaults to the HTTPS
 * interface on 8443 - what ClickHouse Cloud hands out. Any path/query is dropped: the
 * client and the write transport both build their own paths from this origin.
 */
export function normalizeUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Host is required");

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid host or URL`);
  }
  if (!url.hostname) throw new Error(`"${input}" is missing a hostname`);

  // URL drops a port that is the scheme's default, so `https://host:443` arrives with an
  // empty url.port and would silently become ClickHouse's 8443 - a connection to somewhere
  // the user never asked for. Read the port from the input instead.
  const authority = withScheme.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  const stated = authority.match(/:(\d+)$/)?.[1];
  const port = stated || url.port || (url.protocol === "https:" ? "8443" : "8123");
  return `${url.protocol}//${url.hostname}:${port}`;
}

/** Host (and port, when non-default) for display in the UI - never the credentials. */
export function displayHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
// Scout is the one making the HTTP request, so an arbitrary user-supplied host is a
// server-side request forgery primitive: left unchecked, "connect me to
// http://169.254.169.254" would turn the connect form into a cloud-metadata reader.
// Public deployments therefore refuse to dial private, loopback and link-local space.
// Self-hosters pointing at a ClickHouse on their own LAN set SCOUT_ALLOW_PRIVATE_HOSTS=1.
//
// This resolves the name and checks the addresses; it does not pin them, so a DNS-rebinding
// attacker who controls a domain can still get a second, different answer on the actual
// request. Closing that needs a pinned-IP dispatcher in the HTTP layer - out of scope here,
// and noted so the gap is not mistaken for coverage.

const PRIVATE_V4 = [
  { net: "10.0.0.0", bits: 8 },
  { net: "172.16.0.0", bits: 12 },
  { net: "192.168.0.0", bits: 16 },
  { net: "127.0.0.0", bits: 8 },
  { net: "169.254.0.0", bits: 16 }, // link-local, incl. the cloud metadata endpoint
  { net: "100.64.0.0", bits: 10 }, // carrier-grade NAT
  { net: "0.0.0.0", bits: 8 },
  { net: "192.0.0.0", bits: 24 },
  { net: "198.18.0.0", bits: 15 },
];

const v4ToInt = (ip: string): number =>
  ip.split(".").reduce((acc, o) => (acc << 8) + (Number(o) & 255), 0) >>> 0;

function isPrivateV4(ip: string): boolean {
  const addr = v4ToInt(ip);
  return PRIVATE_V4.some(({ net, bits }) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (v4ToInt(net) & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase().split("%")[0]; // strip any zone id
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(a)) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:10.0.0.1) - judge the embedded v4 address.
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]) : false;
}

const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip);

export const allowsPrivateHosts = (): boolean =>
  process.env.SCOUT_ALLOW_PRIVATE_HOSTS === "1" || process.env.SCOUT_ALLOW_PRIVATE_HOSTS === "true";

/**
 * Reject a host that resolves into private/loopback/link-local space, so a public
 * deployment can't be aimed at its own internal network. No-op when the operator has
 * opted in via SCOUT_ALLOW_PRIVATE_HOSTS.
 */
export async function assertReachableHost(url: string): Promise<void> {
  if (allowsPrivateHosts()) return;
  // URL keeps the brackets on an IPv6 literal; isIP() and the range checks want them off.
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(privateHostMessage(hostname));
    return;
  }
  if (/^localhost$/i.test(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new Error(privateHostMessage(hostname));
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Couldn't resolve "${hostname}". Check the host and try again.`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(privateHostMessage(hostname));
  }
}

function privateHostMessage(host: string): string {
  return (
    `"${host}" resolves to a private or loopback address, which this deployment won't dial. ` +
    `Use a publicly reachable ClickHouse endpoint, or self-host Scout with SCOUT_ALLOW_PRIVATE_HOSTS=1.`
  );
}
