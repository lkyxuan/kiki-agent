// Access guard: Kiki can run commands on your computer, so it only accepts requests from "you".
//   1. Host must be a local hostname, a Tailscale domain (*.ts.net), or a Tailscale internal IP (100.64.0.0/10, fd7a:115c:a1e0::/48), blocking DNS rebinding.
//   2. Requests that change things (POST) with an Origin must match the Host, blocking other web pages from sneakily sending requests (CSRF).
// To allow other hostnames, add them to KIKI_ALLOWED_HOSTS (comma-separated).
import type { IncomingMessage } from "node:http";

// Read fresh each time: this module loads earlier than main.ts reads .env
const extra = () =>
  (process.env.KIKI_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

// The IP Tailscale assigns to each device: IPv4 in 100.64.0.0/10, IPv6 in fd7a:115c:a1e0::/48
export function tailscaleIp(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255;
  }
  return h.startsWith("fd7a:115c:a1e0:");
}

export function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = hostname(host);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".ts.net") || tailscaleIp(h) || extra().includes(h);
}

/** Returns the rejection reason; returns undefined when allowed. */
export function rejectReason(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (!allowedHost(host)) return `Unrecognized hostname ${host}`;
  const origin = req.headers.origin;
  if (req.method !== "GET" && req.method !== "HEAD" && origin) {
    try {
      // Behind a reverse proxy like Tailscale Serve, the original hostname may be in X-Forwarded-Host
      const o = new URL(origin).host.toLowerCase();
      const fwd = String(req.headers["x-forwarded-host"] ?? "").toLowerCase();
      if (o !== host!.toLowerCase() && o !== fwd) return "Cross-site request";
    } catch {
      return "Cross-site request";
    }
  }
}
