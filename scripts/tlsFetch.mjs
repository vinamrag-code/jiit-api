/**
 * A `fetch` for Node that can actually reach the portal.
 *
 * Node's built-in fetch offers TLS 1.3, and the portal's server aborts most of those handshakes
 * ("socket hang up" / "Client network socket disconnected before secure TLS connection was established").
 * Capping at TLS 1.2 - what curl and browsers negotiate anyway - makes it reliable. Measured against the
 * live server on 18 Sep 2026: 0/3 requests succeeded on Node's defaults, 3/3 capped.
 *
 * Built on `node:https` rather than undici so the agent options are reachable without a dependency. It
 * returns only the parts of the Response interface this library uses.
 */
import https from "node:https";
import http from "node:http";

export function createTlsFetch({ maxVersion = "TLSv1.2" } = {}) {
  const agent = new https.Agent({ maxVersion, keepAlive: true });

  return function tlsFetch(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === "http:" ? http : https;
      const payload = body === undefined || body === null ? null : Buffer.from(body);

      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method,
          headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) },
          ...(transport === https ? { agent } : {}),
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString("utf8");
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage ?? "",
              ok: res.statusCode >= 200 && res.statusCode < 300,
              headers: res.headers,
              text: async () => text,
              json: async () => JSON.parse(text),
              blob: async () => ({ size: buffer.length, type: res.headers["content-type"] ?? "" }),
              arrayBuffer: async () => buffer,
            });
          });
        },
      );

      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}
