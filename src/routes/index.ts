import { getBodyBuffer } from "@/utils/body";
import { getProxyHeaders, getAfterResponseHeaders, getBlacklistedHeaders } from "@/utils/headers";
import { createTokenIfNeeded, isAllowedToMakeRequest, setTokenHeader } from "@/utils/turnstile";
import { hasProxyKey } from "@/utils/proxy-key";

export default defineEventHandler(async (event) => {
  // Handle preflight CORS requests
  if (isPreflightRequest(event)) {
    handleCors(event, {});
    // Ensure the response ends here for preflight
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  // Reject any other OPTIONS requests
  if (event.node.req.method === "OPTIONS") {
    throw createError({
      statusCode: 405,
      statusMessage: "Method Not Allowed",
    });
  }

  // Parse destination URL
  const destination = getQuery<{ destination?: string }>(event).destination;
  if (!destination) {
    return await sendJson({
      event,
      status: 200,
      data: {
        message: `Proxy is working as expected (v${useRuntimeConfig(event).version})`,
      },
    });
  }

  // `destination` is a plain URL, so without a key anyone could fetch any site through the VM.
  // Only flux-v2's server sends the key. Cloudflare also blocks keyless requests before its cache.
  if (!hasProxyKey(event)) {
    return await sendJson({ event, status: 401, data: { error: "Invalid or missing proxy key" } });
  }

  // Check if allowed to make the request
  if (!(await isAllowedToMakeRequest(event))) {
    return await sendJson({
      event,
      status: 401,
      data: {
        error: "Invalid or missing token",
      },
    });
  }

  // Read body and create token if needed
  const body = await getBodyBuffer(event);
  const token = await createTokenIfNeeded(event);

  // Proxy the request
  console.log(`[proxy] ${event.method} ${destination}`);
  try {
    await specificProxyRequest(event, destination, {
      blacklistedHeaders: getBlacklistedHeaders(),
      fetchOptions: {
        redirect: "follow",
        headers: getProxyHeaders(event.headers),
        body,
      },
      onResponse(outputEvent, response) {
        const headers = getAfterResponseHeaders(response.headers, response.url);
        setResponseHeaders(outputEvent, headers);
        if (token) setTokenHeader(event, token);
      },
    });
  } catch (e) {
    console.error(`[proxy] FAIL ${destination}`, e);
    throw e;
  }
});
