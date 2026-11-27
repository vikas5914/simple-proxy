import { timingSafeEqual } from "node:crypto";
import { H3Event, EventHandlerRequest } from "h3";

const proxyKey = process.env.PROXY_KEY ?? "";
if (!proxyKey) console.warn("[proxy] PROXY_KEY is not set; /?destination= refuses every request");

export function hasProxyKey(event: H3Event<EventHandlerRequest>): boolean {
  if (!proxyKey) return false;
  const sent = Buffer.from(getHeader(event, "x-proxy-key") ?? "");
  const expected = Buffer.from(proxyKey);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}
