/**
 * PM2 ecosystem config – production cluster mode for strapifrontend.
 *
 * This starts one Next.js worker per logical CPU (minus one reserved for
 * Strapi + OS), so all 14 cores are put to work instead of just one.
 *
 * HOW TO USE
 * ──────────
 * Install PM2 globally once:
 *   npm install -g pm2
 *
 * Build, then start the cluster:
 *   npm run build
 *   pm2 start pm2.config.js
 *
 * Useful PM2 commands:
 *   pm2 status           – show all workers
 *   pm2 logs             – tail logs from all workers
 *   pm2 monit            – live CPU/RAM dashboard
 *   pm2 reload all       – zero-downtime restart (workers restart one-by-one)
 *   pm2 stop all         – stop all workers
 *   pm2 delete all       – remove from PM2 daemon
 *
 * Auto-restart on reboot:
 *   pm2 startup          – follow the printed instructions once
 *   pm2 save             – save the current process list
 */

module.exports = {
  apps: [
    {
      name: "strapifrontend",
      // Run the custom programmatic server (server.js), NOT `next start`.
      // `next start` is incompatible with PM2 cluster mode — see server.js.
      script: "server.js",

      // ── Clustering ─────────────────────────────────────────────────────
      // -1 = all logical CPUs minus one (leaves headroom for Strapi + OS)
      instances: -1,
      exec_mode: "cluster",

      // ── Memory / node options ──────────────────────────────────────────
      // Give each worker up to 512 MB before PM2 auto-restarts it.
      // Raise max_memory_restart if you have plenty of RAM.
      node_args: "--max-old-space-size=512",
      max_memory_restart: "512M",

      // ── Environment ────────────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      // ── Reliability ────────────────────────────────────────────────────
      // Restart a crashed worker automatically, with exponential back-off.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      // ── Logging ────────────────────────────────────────────────────────
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
