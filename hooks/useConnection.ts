// useConnection - the client half of "link your own ClickHouse, and Scout remembers".
//
// The credentials themselves never live here: connect() posts them once, the server seals
// them into an httpOnly cookie (lib/db/session.ts), and from then on this hook only ever
// holds the harmless summary (host, database, table count) that GET /api/db-info returns.
// A page reload re-reads that summary, which is what makes the link feel persistent.

"use client";

import { useCallback, useEffect, useState } from "react";

/** What the app knows about the linked warehouse - never the password. */
export interface ConnectionInfo {
  connected: boolean;
  host?: string;
  database?: string;
  username?: string;
  /** ClickHouse server version, from the connect handshake. */
  version?: string;
  /** Tables discovered at link time, shown on the tour's final screen. */
  tables?: number;
}

/** The form the setup tour collects. */
export interface ConnectionForm {
  host: string;
  username: string;
  password: string;
  database: string;
}

export interface ConnectionState {
  /** null while the initial status fetch is in flight (the app shows nothing rather than flashing the tour). */
  info: ConnectionInfo | null;
  connect: (form: ConnectionForm) => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<void>;
  /** Called when any request comes back 428, so the UI drops to the tour immediately. */
  markDisconnected: () => void;
}

export function useConnection(): ConnectionState {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/db-info")
      .then((r) => r.json())
      .then((d: ConnectionInfo) => !cancelled && setInfo(d))
      .catch(() => !cancelled && setInfo({ connected: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (form: ConnectionForm) => {
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data?.error || `Connection failed (${res.status})` };
      setInfo(data as ConnectionInfo);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await fetch("/api/disconnect", { method: "POST" });
    } catch {
      // Even if the round-trip fails, drop the local state: the user asked to unlink.
    }
    setInfo({ connected: false });
  }, []);

  const markDisconnected = useCallback(() => setInfo({ connected: false }), []);

  return { info, connect, disconnect, markDisconnected };
}
