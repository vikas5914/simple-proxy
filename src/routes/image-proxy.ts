import { sendStream, setResponseHeaders } from "h3";
import { decryptUrl, getSecret } from "../utils/encryption";
import { FETCH_TIMEOUT_MS } from "../utils/constants";

const encryptionKey = process.env.URL_ENCRYPTION_KEY;

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

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

  try {
    // Build Referer from the image URL's origin if not provided
    const imageUrl = new URL(decryptedUrl);
    const defaultReferer = imageUrl.origin + "/";

    const fetchHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
      Referer: defaultReferer,
      ...(headers as HeadersInit),
    };
    console.log(`[image-proxy] GET ${decryptedUrl}`);

    const response = await globalThis.fetch(decryptedUrl, {
      method: "GET",
      headers: fetchHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const upstreamCacheControl = response.headers.get("cache-control");
    const upstreamExpires = response.headers.get("expires");

    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    };

    if (upstreamCacheControl) {
      responseHeaders["Cache-Control"] = upstreamCacheControl;
    }

    if (upstreamExpires) {
      responseHeaders.Expires = upstreamExpires;
    }

    setResponseHeaders(event, responseHeaders);

    return sendStream(event, response.body as ReadableStream);
  } catch (error: any) {
    console.error(`[image-proxy] FAIL ${decryptedUrl || url}`, error.message);
    return sendError(
      event,
      createError({
        statusCode: 500,
        statusMessage: error.message || "Error proxying image",
      }),
    );
  }
});
