import { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["gluon-ergo-sdk"],
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-eval' 'unsafe-inline' 'wasm-unsafe-eval';"
      : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';";
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `${scriptSrc} object-src 'none'; base-uri 'self';`,
          },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    config.target = isServer ? 'node16' : ['web', 'es2020'];
    return config;
  },
};

export default nextConfig;
