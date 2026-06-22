import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ClickHouse + OpenAI SDKs are server-only; keep them external to the bundle.
  serverExternalPackages: ["@clickhouse/client"],
  experimental: {
    // Allow larger request bodies for CSV uploads on the chat/upload routes.
    serverActions: { bodySizeLimit: "1gb" },
  },
};

export default nextConfig;
