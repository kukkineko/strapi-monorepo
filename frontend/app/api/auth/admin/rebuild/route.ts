import { NextResponse } from "next/server";
import { getSessionJwt, getStrapiMe } from "@/app/lib/auth-server";
import { exec } from "child_process";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

export async function POST() {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await getStrapiMe(jwt);
  if (!user?.administrator) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = (s: string) => new TextEncoder().encode(s);

        function send(line: string) {
          controller.enqueue(enc(`data: ${JSON.stringify(line)}\n\n`));
        }

        send("Starting production build…");

        const build = exec("npm run build", { cwd: PROJECT_ROOT });

        build.stdout?.on("data", (chunk: string) => {
          for (const line of String(chunk).split("\n")) {
            if (line.trim()) send(line);
          }
        });
        build.stderr?.on("data", (chunk: string) => {
          for (const line of String(chunk).split("\n")) {
            if (line.trim()) send(line);
          }
        });

        build.on("close", (code) => {
          if (code !== 0) {
            send(`__ERROR__Build failed with exit code ${code}`);
            controller.close();
            return;
          }

          send("Build complete. Restarting pm2…");

          const restart = exec("pm2 restart all", { cwd: PROJECT_ROOT });

          restart.stdout?.on("data", (chunk: string) => {
            for (const line of String(chunk).split("\n")) {
              if (line.trim()) send(line);
            }
          });
          restart.stderr?.on("data", (chunk: string) => {
            for (const line of String(chunk).split("\n")) {
              if (line.trim()) send(line);
            }
          });

          restart.on("close", (code2) => {
            if (code2 !== 0) {
              send(`__ERROR__pm2 restart failed with exit code ${code2}`);
            } else {
              send("__DONE__Server restarted successfully.");
            }
            controller.close();
          });
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}
