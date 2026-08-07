module.exports = ({ env }) => ({
  'rest-cache': {
    enabled: true,
    config: {
      provider: {
        name: 'memory',
        options: {
          // QuickLRU max items (provider renames max -> maxSize internally)
          max: 2000,
          // Provider-level TTL in seconds (1 hour)
          ttl: 3600,
        },
      },
      strategy: {
        // Per-response TTL in seconds; also auto-invalidated on any write/update/delete
        maxAge: 3600,
        // X-Cache: HIT/MISS headers for observability
        enableXCacheHeaders: true,
        // Only cache api::entry.entry JSON responses.
        // plugin::upload.file is intentionally excluded — image binaries are
        // served directly from disk by Strapi upload middleware, not via this cache.
        contentTypes: [
          'api::entry.entry',
        ],
      },
    },
  },
});
