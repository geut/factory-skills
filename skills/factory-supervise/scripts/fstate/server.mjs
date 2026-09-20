import { createServer } from "node:http";
import { CliError, EXIT_IO, EXIT_NOT_FOUND } from "./errors.mjs";
import { listEvents, openStore, readMeta } from "./store.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const POLL_MS = 200;
const PING_MS = 15000;

function isLocalhostOrigin(origin) {
  if (!origin) {
    return false;
  }
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allow = !origin || isLocalhostOrigin(origin) ? (origin || "*") : null;
  if (!allow) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-cache",
  };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function parseCursor(req, url) {
  const afterParam = url.searchParams.get("after");
  if (afterParam != null && afterParam !== "") {
    const after = Number(afterParam);
    if (!Number.isInteger(after) || after < 0) {
      return { error: "after must be a non-negative integer" };
    }
    return { last: after, hello: false };
  }
  const header = req.headers["last-event-id"];
  if (header != null && header !== "") {
    const last = Number(header);
    if (!Number.isInteger(last) || last < 0) {
      return { error: "Last-Event-ID must be a non-negative integer" };
    }
    return { last, hello: false };
  }
  return { last: null, hello: true };
}

function writeSse(res, { id, event, data }) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function eventPayload(row) {
  let payload = {};
  try {
    payload = row.payload ? JSON.parse(row.payload) : {};
  } catch {
    payload = {};
  }
  return {
    revision: row.revision,
    at: row.at,
    op: row.op,
    ticket: row.ticket_id ?? null,
    task: row.task_id ?? null,
    payload,
  };
}

function handleEvents(req, res, db, extraHeaders) {
  const url = new URL(req.url, "http://127.0.0.1");
  const cursor = parseCursor(req, url);
  if (cursor.error) {
    json(res, 400, { ok: false, error: cursor.error }, extraHeaders);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extraHeaders,
  });
  res.flushHeaders();
  req.socket?.setNoDelay(true);
  res.write(": connected\n\n");
  let last = cursor.last;
  if (cursor.hello) {
    const meta = readMeta(db);
    last = meta.revision;
    writeSse(res, { event: "hello", data: { revision: meta.revision } });
  }
  const sendNew = () => {
    const rows = listEvents(db, last);
    for (const row of rows) {
      last = row.revision;
      writeSse(res, { id: row.revision, event: row.op, data: eventPayload(row) });
    }
  };
  sendNew();
  const poll = setInterval(sendNew, POLL_MS);
  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, PING_MS);
  const cleanup = () => {
    clearInterval(poll);
    clearInterval(ping);
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
}

export function startServer({ factoryRoot, host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const db = openStore(factoryRoot, { readOnly: true });
  if (!db) {
    throw new CliError("factory state not found", EXIT_NOT_FOUND);
  }
  const server = createServer((req, res) => {
    const extraHeaders = corsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, extraHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method not allowed" }, extraHeaders);
      return;
    }
    try {
      if (url.pathname === "/health") {
        const meta = readMeta(db);
        json(res, 200, { ok: true, revision: meta.revision, schemaVersion: meta.schemaVersion }, extraHeaders);
        return;
      }
      if (url.pathname === "/events") {
        handleEvents(req, res, db, extraHeaders);
        return;
      }
      json(res, 404, { ok: false, error: "not found" }, extraHeaders);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message || String(err) }, extraHeaders);
    }
  });
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      db.close();
      reject(new CliError(`cannot listen on ${host}:${port}: ${err.message}`, EXIT_IO));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const boundHost = address.address === "::" ? "127.0.0.1" : address.address;
      const boundPort = address.port;
      resolve({
        server,
        host: boundHost,
        port: boundPort,
        url: `http://${boundHost}:${boundPort}/events`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => {
              db.close();
              if (err) {
                closeReject(err);
              } else {
                closeResolve();
              }
            });
          }),
      });
    });
  });
}

export { DEFAULT_HOST, DEFAULT_PORT };
