import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: {
    "/": ["./data/memory.db", "./node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
    "/api/ask": ["./data/memory.db", "./node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
  },
  turbopack: { root: process.cwd() },
};

export default config;
