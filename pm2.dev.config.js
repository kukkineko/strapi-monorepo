/**
 * PM2 config for dev build on port 3001.
 *
 * This runs a separate development instance that does NOT interfere with
 * the production cluster on port 3000.
 *
 * Usage:
 *   npm run start:dev
 *   npm run stop:dev
 *   npm run logs:dev
 */

module.exports = {
  apps: [
    {
      name: "strapifrontend-dev",
      script: "server.js",

      // Single instance for development (no clustering)
      instances: 1,
      exec_mode: "fork",

      // Node options for dev
      node_args: "--max-old-space-size=512",

      // Environment
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 5,
      restart_delay: 1000,

      // Logging
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
