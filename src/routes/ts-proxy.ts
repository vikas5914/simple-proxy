import { setResponseHeaders, sendStream } from "h3";
import { decryptUrl, getSecret } from "../utils/encryption";
import { FETCH_TIMEOUT_MS } from "../utils/constants";
import { getCachedSegment } from "./m3u8-proxy";

// Check if caching is enabled via environment variable (disabled by default)
const isCacheDisabled = () => process.env.ENABLE_CACHE !== "true";
const encryptionKey = process.env.URL_ENCRYPTION_KEY;

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

    const fetchHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0",
      ...(range ? { Range: range } : {}),
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

    // Relay partial responses as they are: MP4 hosts may cap each response (e.g. 4 MiB per 206)
    // and the player then asks for the next range.
    setResponseStatus(event, response.status);
    for (const name of ["Content-Range", "Accept-Ranges"]) {
      const value = response.headers.get(name);
      if (value) setResponseHeader(event, name, value);
    }
    const length = response.headers.get("content-length");
    if (length && !response.headers.has("content-encoding")) {
      setResponseHeader(event, "Content-Length", length);
    }

    if (!response.body) {
      throw new Error("Response body is empty");
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
