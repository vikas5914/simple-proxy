import { setResponseHeaders, sendStream } from "h3";
import { decryptUrl, getSecret } from "../utils/encryption";
import { FETCH_TIMEOUT_MS } from "../utils/constants";
import { isPromoRedirect } from "../utils/promo";
import { getCachedSegment } from "./m3u8-proxy";

// Check if caching is enabled via environment variable (disabled by default)
const isCacheDisabled = () => process.env.ENABLE_CACHE !== "true";
const encryptionKey = process.env.URL_ENCRYPTION_KEY;

function parseContentRange(value: string | null) {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

// Some hosts cap every response (dramabox-stream sends 4 MiB per 206) even when no Range was
// asked for. Cloudflare drops Range on cache misses and wants the whole file, so fetch the
// remaining ranges and send them on as one body.
function joinCappedRanges(
  url: string,
  fetchHeaders: HeadersInit,
  first: Response,
  firstEnd: number,
  total: number,
  chunkBytes: number | null,
): ReadableStream<Uint8Array> {
  const headers = new Headers(fetchHeaders);
  let next = firstEnd + 1;
  const rangeFrom = (start: number) =>
    chunkBytes ? `bytes=${start}-${Math.min(start + chunkBytes, total) - 1}` : `bytes=${start}-`;
  let reader = first.body!.getReader();
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        if (next >= total) {
          controller.close();
          return;
        }
        headers.set("Range", rangeFrom(next));
        const res = await globalThis.fetch(url, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const part = parseContentRange(res.headers.get("content-range"));
        if (res.status !== 206 || !res.body || part?.start !== next || part.total !== total) {
          throw new Error(`Bad range from upstream: ${res.status} for ${rangeFrom(next)}`);
        }
        next = part.end + 1;
        reader = res.body.getReader();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// googlevideo throttles an open-ended request for most of a file (no Range, `bytes=0-`,
// `bytes=2097152-` of 14 MB) to below real-time speed, but sends bounded ranges at full speed.
const CHUNKED_HOSTS = ["googlevideo.com"];
const CHUNK_BYTES = 4 * 1024 * 1024;

function chunkBytesFor(url: string): number | null {
  const host = new URL(url).hostname;
  return CHUNKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? CHUNK_BYTES : null;
}

// Open-ended ranges become one bounded chunk; the player asks for the next one itself.
function upstreamRange(range: string | undefined, chunkBytes: number | null): string | undefined {
  if (!chunkBytes) return range;
  if (!range) return `bytes=0-${chunkBytes - 1}`;
  const start = /^bytes=(\d+)-$/.exec(range.trim())?.[1];
  return start ? `bytes=${start}-${Number(start) + chunkBytes - 1}` : range;
}

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  if (process.env.DISABLE_M3U8 === "true") {
    return sendError(
      event,
      createError({
        statusCode: 404,
        statusMessage: "TS proxying is disabled",
      }),
    );
  }

  const url = getQuery(event).url as string;
  const headersParam = getQuery(event).headers as string;

  if (!url) {
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage: "URL parameter is required",
      }),
    );
  }

  if (!encryptionKey) {
    return sendError(
      event,
      createError({
        statusCode: 500,
        statusMessage: "URL encryption key is required",
      }),
    );
  }

  const secret = getSecret(encryptionKey);

  let decryptedUrl = "";
  try {
    decryptedUrl = decryptUrl(url, secret);
  } catch {
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage: "Invalid URL format",
      }),
    );
  }

  let headers = {};
  try {
    headers = headersParam ? JSON.parse(headersParam) : {};
  } catch {
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage: "Invalid headers format",
      }),
    );
  }

  const range = getRequestHeader(event, "range");

  try {
    // Only check cache if caching is enabled; it holds whole segments, so it cannot answer a Range
    if (!isCacheDisabled() && !range) {
      const cachedSegment = getCachedSegment(decryptedUrl);

      if (cachedSegment) {
        setResponseHeaders(event, {
          "Content-Type": cachedSegment.headers["content-type"] || "video/mp2t",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
          "Cache-Control": "public, max-age=3600", // Allow caching of TS segments
        });

        return cachedSegment.data;
      }
    }

    const chunkBytes = chunkBytesFor(decryptedUrl);
    const sentRange = upstreamRange(range, chunkBytes);
    const fetchHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0",
      ...(sentRange ? { Range: sentRange } : {}),
      ...(headers as HeadersInit),
    };
    console.log(`[ts-proxy] GET ${decryptedUrl}${range ? ` ${range}` : ""}`);

    const response = await globalThis.fetch(decryptedUrl, {
      method: "GET",
      headers: fetchHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 416) {
      throw new Error(`Failed to fetch TS file: ${response.status} ${response.statusText}`);
    }
    if (isPromoRedirect(response)) {
      await response.body?.cancel();
      console.error(`[ts-proxy] FAIL promo redirect ${decryptedUrl} -> ${response.url}`);
      return sendError(
        event,
        createError({ statusCode: 502, statusMessage: "Upstream redirected to a promo clip" }),
      );
    }

    // Some segment hosts disguise TS as images, so only trust a real media type (e.g. MP4).
    const upstreamType = response.headers.get("content-type") ?? "";
    setResponseHeaders(event, {
      "Content-Type": /^(video|audio)\//i.test(upstreamType) ? upstreamType : "video/mp2t",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
      "Cache-Control": "public, max-age=3600", // Allow caching of TS segments
    });

    if (!response.body) {
      throw new Error("Response body is empty");
    }

    const capped = parseContentRange(response.headers.get("content-range"));
    if (!range && response.status === 206 && capped?.start === 0) {
      setResponseHeaders(event, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(capped.total),
      });
      return sendStream(
        event,
        joinCappedRanges(
          decryptedUrl,
          fetchHeaders,
          response,
          capped.end,
          capped.total,
          chunkBytes,
        ),
      );
    }

    // Relay partial responses as they are; the player asks for the next range itself.
    setResponseStatus(event, response.status);
    for (const name of ["Content-Range", "Accept-Ranges"]) {
      const value = response.headers.get(name);
      if (value) setResponseHeader(event, name, value);
    }
    const length = response.headers.get("content-length");
    if (length && !response.headers.has("content-encoding")) {
      setResponseHeader(event, "Content-Length", length);
    }

    return sendStream(event, response.body);
  } catch (error: any) {
    console.error(`[ts-proxy] FAIL ${decryptedUrl || url}`, error.message);
    return sendError(
      event,
      createError({
        statusCode: error.response?.status || 500,
        statusMessage: error.message || "Error proxying TS file",
      }),
    );
  }
});
