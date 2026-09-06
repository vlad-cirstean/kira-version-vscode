/**
 * `docs/plans/P8.md` W18: a real HTTP remote for `withRemote({ requireAuth, slow })`, serving one
 * bare repo through `git http-backend` — the same CGI program a real git host runs behind nginx
 * or Apache — rather than a hand-rolled stand-in for git's own smart-HTTP protocol. The plan's own
 * probe 8 ("a real HTTP 401 server") used exactly this shape; this file makes it a reusable
 * fixture instead of a one-off scratch script.
 *
 * Two independent knobs, composed in one server because both attach to the same request:
 *  - `auth`: reject with a real `401` + `WWW-Authenticate: Basic` until the request carries the
 *    matching `Authorization` header — the mechanism probe 7/8 exercised, and the only way to
 *    reach the askpass broker's real code path (`GIT_ASKPASS` is only ever consulted once git has
 *    something to prompt *for*) rather than simulating what a 401 "would" do.
 *  - `delayMs`: paces `git http-backend`'s own stdout back to the client one small slice at a
 *    time — real backpressure on a real pack transfer, not a `setTimeout` sprinkled into a fake
 *    response, so a cancel-mid-fetch test has something genuine in flight to cancel.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { baseEnv } from "./generateRepo.ts";

export interface GitHttpBackendOptions {
  /** When set, every request must carry `Authorization: Basic base64(username:password)` or the
   *  server answers `401` before `git http-backend` ever runs. */
  readonly auth?: { readonly username: string; readonly password: string };
  /** When set, `git http-backend`'s response body is forwarded in small chunks, one per this many
   *  milliseconds, instead of as fast as the pipe allows. */
  readonly delayMs?: number;
}

export interface GitHttpBackend {
  /** The bare repo's own clone URL — `git clone <url>` reaches exactly this repo, at the root
   *  path, no repo-name segment (`GIT_PROJECT_ROOT` is the repo itself, not its parent). */
  readonly url: string;
  close(): Promise<void>;
}

function parseCgiHeaders(
  buffer: Buffer,
): { status: number; headers: http.OutgoingHttpHeaders; bodyStart: number } | undefined {
  const sep = buffer.indexOf("\r\n\r\n");
  if (sep === -1) return undefined;
  const headerText = buffer.subarray(0, sep).toString("latin1");
  const headers: http.OutgoingHttpHeaders = {};
  let status = 200;
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") {
      status = Number.parseInt(value, 10) || 200;
    } else {
      headers[key] = value;
    }
  }
  return { status, headers, bodyStart: sep + 4 };
}

/** Trickles `chunk` into `res` a small slice at a time, `delayMs` apart — real, observable
 *  backpressure rather than one fast write followed by a sleep nobody is waiting on. */
async function writeThrottled(
  res: http.ServerResponse,
  chunk: Buffer,
  delayMs: number,
): Promise<void> {
  const SLICE = 512;
  for (let offset = 0; offset < chunk.length; offset += SLICE) {
    res.write(chunk.subarray(offset, offset + SLICE));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function startGitHttpBackend(
  bareRepoDir: string,
  opts: GitHttpBackendOptions = {},
): Promise<GitHttpBackend> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (opts.auth) {
        const expected = `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString("base64")}`;
        if (req.headers.authorization !== expected) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="kira-version-test"' });
          res.end("authentication required");
          return;
        }
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const child: ChildProcessWithoutNullStreams = spawn("git", ["http-backend"], {
        cwd: bareRepoDir,
        env: {
          ...baseEnv(bareRepoDir),
          GIT_PROJECT_ROOT: bareRepoDir,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.replace(/^\?/, ""),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: req.headers["content-length"] ?? "",
          GIT_HTTP_MAX_REQUEST_BUFFER: "10m",
        },
      });
      req.pipe(child.stdin);

      let headerBuf = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (headersSent) {
          if (opts.delayMs) void writeThrottled(res, chunk, opts.delayMs);
          else res.write(chunk);
          return;
        }
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const parsed = parseCgiHeaders(headerBuf);
        if (!parsed) return;
        headersSent = true;
        res.writeHead(parsed.status, parsed.headers);
        const body = headerBuf.subarray(parsed.bodyStart);
        if (body.length > 0) {
          if (opts.delayMs) void writeThrottled(res, body, opts.delayMs);
          else res.write(body);
        }
      });
      child.stderr.on("data", () => {
        // git http-backend's own diagnostics — not part of the CGI response, and not needed by
        // any test; swallowed so it never interleaves with this process's own stdout.
      });
      child.on("close", () => {
        if (!res.writableEnded) res.end();
      });
      child.on("error", (err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
      // `res`'s own `close`, not `req`'s: the request stream fires `close` the moment its body
      // (often empty, for a GET) has been fully read — well before the response is written on a
      // keep-alive connection — so watching it kills `git http-backend` before it ever produces a
      // byte. `res.close` fires only when the underlying connection actually drops, and the
      // `writableEnded` guard means a normal, fully-sent response never reaches `child.kill()` at
      // all — only a genuine client-side abort (a real cancel-mid-fetch, W19's own scenario) does.
      res.on("close", () => {
        if (!res.writableEnded && !child.killed) child.kill();
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error("startGitHttpBackend: server did not bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
