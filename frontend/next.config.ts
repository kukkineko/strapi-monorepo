import type { NextConfig } from "next";

const STRAPI_ORIGIN = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");

/**
 * Baseline security headers — this app loads no third-party scripts/fonts and
 * has no login-frame use case, so there's no reason it should ever be
 * embeddable or leak referrers cross-origin. `'unsafe-inline'` stays on
 * script-src/style-src because the App Router streams inline hydration
 * scripts and this codebase uses React's `style={{...}}` prop extensively —
 * removing it would need a nonce plumbed through middleware, a larger change
 * this header addition isn't the place for. Even with that allowance, the
 * policy still blocks loading script/style/frame/object content from any
 * origin other than this one, which is the actual exfiltration/clickjacking
 * surface these headers exist to close.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
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
