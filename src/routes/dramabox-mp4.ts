import { sendStream, setResponseHeaders } from "h3";
import { decryptUrl, getSecret } from "../utils/encryption";
import {
  DramaBoxError,
  decryptedStream,
  getDramaBoxMeta,
  isDramaBoxEncrypted,
} from "../utils/dramabox";

const encryptionKey = process.env.URL_ENCRYPTION_KEY;

function parseRange(header: string | undefined, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Math.min(Number(m[2]), size);
    return suffix > 0 ? [size - suffix, size - 1] : null;
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end ? [start, end] : null;
}

// Plays DramaBox "*.encrypt.mp4" files by decrypting them on the way through. Cloudflare drops
// Range on a cache miss, takes the whole decrypted file, and then answers ranges from its cache.
export default defineEventHandler(async (event) => {
  if (isPreflightRequest(event)) return handleCors(event, {});

  const token = getQuery(event).url as string;
  if (!token) {
    return sendError(event, createError({ statusCode: 400, statusMessage: "URL is required" }));
  }
  if (!encryptionKey) {
    return sendError(
      event,
      createError({ statusCode: 500, statusMessage: "URL encryption key is required" }),
    );
  }

  let url = "";
  try {
    url = decryptUrl(token, getSecret(encryptionKey));
  } catch {
    return sendError(event, createError({ statusCode: 400, statusMessage: "Invalid URL format" }));
  }
  if (!isDramaBoxEncrypted(url)) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "Not a DramaBox encrypted mp4" }),
    );
  }

  setResponseHeaders(event, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  });

  try {
    const meta = await getDramaBoxMeta(url);
    const rangeHeader = getRequestHeader(event, "range");
    const range = rangeHeader ? parseRange(rangeHeader, meta.size) : [0, meta.size - 1];
    if (!range) {
      setResponseStatus(event, 416);
      setResponseHeader(event, "Content-Range", `bytes */${meta.size}`);
      return null;
    }
    const [start, end] = range;
    setResponseHeaders(event, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      // The bytes behind a path never change; only the signed query does.
      "Cache-Control": "public, max-age=86400",
    });
    if (rangeHeader) {
      setResponseStatus(event, 206);
      setResponseHeader(event, "Content-Range", `bytes ${start}-${end}/${meta.size}`);
    }
    if (event.method === "HEAD") return "";
    console.log(`[dramabox-mp4] GET ${new URL(url).pathname} ${rangeHeader ?? "full"}`);
    return sendStream(event, decryptedStream(url, meta, start, end));
  } catch (error) {
    const status = error instanceof DramaBoxError && error.status >= 400 ? error.status : 502;
    console.error(`[dramabox-mp4] FAIL ${url}`, error instanceof Error ? error.message : error);
    return sendError(
      event,
      createError({
        statusCode: status,
        statusMessage: error instanceof Error ? error.message : "decrypt failed",
      }),
    );
  }
});
