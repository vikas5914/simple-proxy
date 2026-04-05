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
    console.error("TS proxy 400: missing url");
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
    console.error("TS proxy 400: invalid encrypted url");
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
    console.error("TS proxy 400: invalid headers");
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage: "Invalid headers format",
      }),
    );
  }

  try {
    // Only check cache if caching is enabled
    if (!isCacheDisabled()) {
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
      ...(headers as HeadersInit),
    };
    console.log("[ts-proxy] outgoing request:", {
      method: "GET",
      url: decryptedUrl,
      headers: fetchHeaders,
    });

    const response = await globalThis.fetch(decryptedUrl, {
      method: "GET",
      headers: fetchHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    console.log("[ts-proxy] response:", {
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch TS file: ${response.status} ${response.statusText}`);
    }

    setResponseHeaders(event, {
      "Content-Type": "video/mp2t",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Cache-Control": "public, max-age=3600", // Allow caching of TS segments
    });

    if (!response.body) {
      throw new Error("Response body is empty");
    }
    return sendStream(event, response.body);
  } catch (error: any) {
    console.error("Error proxying TS file:", error);
    return sendError(
      event,
      createError({
        statusCode: error.response?.status || 500,
        statusMessage: error.message || "Error proxying TS file",
      }),
    );
  }
});
