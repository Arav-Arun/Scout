import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ClickHouse + OpenAI SDKs are server-only; keep them external to the bundle.
  serverExternalPackages: ["@clickhouse/client"],
};

export default nextConfig;
