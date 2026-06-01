import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  compress: true,
  poweredByHeader: false,
  /* pdfjs-dist is ESM-only with an optional native canvas peer dep and a
     "fake worker" code path that the Next.js bundler trips over. Opting
     it out routes through Node's native loader and lets us dynamic-import
     `pdfjs-dist/legacy/build/pdf.mjs` straight from node_modules. Used by
     the import-data route to extract PDF text server-side. */
  serverExternalPackages: ["pdfjs-dist"],
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "172.19.*.*",
    "192.168.*.*",
  ],
  images: {
    minimumCacheTTL: 3600,
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        port: "1337",
        pathname: "/uploads/**",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "1337",
        pathname: "/uploads/**",
      },
    ],
  },
};

export default nextConfig;
