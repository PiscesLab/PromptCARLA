import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: [
        process.env.NEXT_PUBLIC_NODE_IP ? `${process.env.NEXT_PUBLIC_NODE_IP}:3000` : '',
        'localhost:3000',
      ].filter(Boolean),
    },
  },
};

export default nextConfig;
