import type { NextConfig } from "next";

const STRAPI_ORIGIN = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");

/**
 * Baseline security headers. The Content-Security-Policy that used to be here
 * broke the "Varianten und Ersatzteile" panel: that panel renders thumbnails
 * via a plain <img src="http://localhost:1337/uploads/..."> pointing straight
 * at the Strapi origin (unlike next/image elsewhere, which proxies through
 * /_next/image and stays same-origin from the browser's point of view), and
 * img-src 'self' blocked that cross-port request outright — which also
 * collapsed the panel's layout since it partly depends on the images having
 * loaded. Removed until it can be scoped to actually allow the Strapi origin
 * (matching next.config.ts's own images.remotePatterns) and be verified
 * against a real logged-in session before going back in.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      {
        source: "/uploads/:path*",
        destination: `${STRAPI_ORIGIN}/uploads/:path*`,
      },
    ];
  },
  cacheComponents: true,
  compress: true,
  poweredByHeader: false,
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
