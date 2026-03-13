import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["128.105.144.61:3000", "localhost:3000"],
    },
  },
};

export default nextConfig;
