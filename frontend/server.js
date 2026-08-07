/**
 * Custom Next.js server for PM2 cluster mode.
 *
 * `next start` cannot run under PM2's cluster mode: its launcher spawns a
 * child process and exits, so the cluster worker has nothing listening and
 * PM2 restarts it forever. This programmatic server instead calls
 * `.listen(PORT)` directly inside the worker, so Node's cluster module hands
 * every worker a share of the same socket — all of them serve on one port.
 *
 * Run via `pm2 start pm2.config.js` (see start:cluster), or directly with
 * `node server.js` for a single-process production server.
 *
 * Note: this file is NOT processed by the Next.js compiler, so keep it plain
 * CommonJS compatible with the installed Node version.
 */
const { createServer } = require("http");
const next = require("next");

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    handle(req, res);
  }).listen(port, () => {
    console.log(
      `> Ready on http://${hostname}:${port} (pid ${process.pid}, ${dev ? "development" : "production"})`
    );
  });
});
