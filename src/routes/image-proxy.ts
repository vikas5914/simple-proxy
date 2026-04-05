import { sendStream, setResponseHeaders } from "h3";
import { decryptUrl, getSecret } from "../utils/encryption";

const encryptionKey = process.env.URL_ENCRYPTION_KEY;

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  const url = getQuery(event).url as string;
  const headersParam = getQuery(event).headers as string;

  if (!url) {
    console.error("Image proxy 400: missing url");
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

  const secret = await getSecret(encryptionKey);

  let decryptedUrl = "";
  try {
    decryptedUrl = await decryptUrl(url, secret);
  } catch {
    console.error("Image proxy 400: invalid encrypted url");
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
    console.error("Image proxy 400: invalid headers");
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage: "Invalid headers format",
      }),
    );
  }

  try {
    const response = await globalThis.fetch(decryptedUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0",
        ...(headers as HeadersInit),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";

    setResponseHeaders(event, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Cache-Control": "public, max-age=31536000, immutable",
    });

    return sendStream(event, response.body as ReadableStream);
  } catch (error: any) {
    console.error("Error proxying image:", error);
    return sendError(
      event,
      createError({
        statusCode: 500,
        statusMessage: error.message || "Error proxying image",
      }),
    );
  }
});
