// session.ts - where a linked connection is remembered, and how.
//
// "Link it once and Scout remembers" is one sealed cookie: the credentials are encrypted
// server-side with AES-256-GCM and the browser only ever holds the ciphertext, so the
// password is never readable by page scripts, extensions, or anyone reading the jar. The
// server decrypts it on each request and hands the result to withConnection().
//
// A cookie (rather than a server-side session table) is what makes Scout deployable as a
// public product with no accounts and no database of its own: state lives with the visitor,
// each browser is isolated, and "Disconnect" is a single cookie deletion.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import type { Connection } from "./connection";

export const CONNECTION_COOKIE = "scout_conn";

/** A year: the link survives restarts and browser sessions until the user disconnects. */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

let _key: Buffer | null = null;

/**
 * The 32-byte sealing key, derived from SCOUT_SECRET. Without that env var a random key is
 * generated per process, which still protects the cookie but means every restart (and every
 * instance behind a load balancer) invalidates existing links - so it warns loudly. Any
 * real deployment sets SCOUT_SECRET.
 */
function key(): Buffer {
  if (_key) return _key;
  const secret = process.env.SCOUT_SECRET;
  if (secret && secret.length >= 16) {
    _key = createHash("sha256").update(secret).digest();
  } else {
    console.warn(
      "[scout] SCOUT_SECRET is not set (or is under 16 chars): sealing saved connections with a " +
        "per-process key. Users will have to re-link their database after every restart. Set " +
        "SCOUT_SECRET to a long random string in production.",
    );
    _key = randomBytes(32);
  }
  return _key;
}

/** Encrypt a connection into an opaque cookie value. */
export function sealConnection(conn: Connection): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(conn), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

/**
 * Decrypt a cookie value back into a connection. Returns null for anything that isn't a
 * valid, current-version, untampered payload - a stale cookie from a previous key just
 * reads as "not connected" and the setup tour opens again.
 */
export function openConnection(value: string | undefined): Connection | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivB64, tagB64, bodyB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const json = Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64url")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(json) as Partial<Connection>;
    if (!parsed.url || !parsed.database) return null;
    return {
      url: String(parsed.url),
      username: String(parsed.username ?? "default"),
      password: String(parsed.password ?? ""),
      database: String(parsed.database),
      readonlyLocked: !!parsed.readonlyLocked,
    };
  } catch {
    return null; // wrong key, tampered payload, or malformed JSON
  }
}

/** The connection linked by this browser, or null. */
export function connectionFrom(request: NextRequest): Connection | null {
  return openConnection(request.cookies.get(CONNECTION_COOKIE)?.value);
}

const cookieOptions = {
  httpOnly: true, // page scripts can never read the credentials
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** Attach the sealed connection to a response (the "remember me" write). */
export function setConnectionCookie(response: NextResponse, conn: Connection): void {
  response.cookies.set(CONNECTION_COOKIE, sealConnection(conn), { ...cookieOptions, maxAge: MAX_AGE_SECONDS });
}

/** Forget the linked connection (the "Disconnect" write). */
export function clearConnectionCookie(response: NextResponse): void {
  response.cookies.set(CONNECTION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}
