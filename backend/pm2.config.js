/**
 * PM2 ecosystem config for the Strapi backend (production).
 *
 * Strapi runs as a single process (it is not cluster-safe the way the Next.js
 * frontend is), so this uses fork mode with one instance.
 *
 * Usage:
 *   npm install --omit=dev      # install production deps
 *   npm run build               # build the admin panel
 *   pm2 start pm2.config.js
 *   pm2 save && pm2 startup     # persist across reboots (follow printed hint)
 */
module.exports = {
  apps: [
    {
      name: "strapi-backend",
      cwd: __dirname,
      script: "npm",
      args: "run start",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "1G",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
