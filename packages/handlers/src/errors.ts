import {
  SeclaiAPIStatusError,
  SeclaiAPIValidationError,
  SeclaiStreamingError,
} from "@seclai/sdk";

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: merged });
}

export function jsonError(
  status: number,
  message: string,
  headers?: HeadersInit,
): Response {
  return json({ error: message, status }, status, headers);
}

/**
 * Pull a human-readable message out of an API error body. The API uses both
 * `{detail}` and `{error: {message}}`, and some bodies are not JSON at all.
 */
function upstreamMessage(responseText: string | undefined): string | undefined {
  if (!responseText) return undefined;
  try {
    const body = JSON.parse(responseText) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    for (const candidate of [
      body.detail,
      body.message,
      (body.error as { message?: unknown } | undefined)?.message,
      body.error,
    ]) {
      if (typeof candidate === "string" && candidate) return candidate;
    }
  } catch {
    // Not JSON. Don't relay it: it could be a proxy's HTML error page.
  }
  return undefined;
}

/**
 * Turn anything thrown while calling the SDK into a response for the browser.
 *
 * Upstream 4xx responses describe the browser's request (a file the agent does
 * not accept, no credits left), so they pass through. A 401/403 means the
 * server's API key is wrong and a 5xx is Seclai's fault. Neither is something
 * the browser can fix, so both are reported as a bad gateway.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof SeclaiAPIValidationError) {
    return json(
      {
        error: "The Seclai API rejected this request as invalid.",
        status: 422,
        details: err.validationError,
      },
      422,
    );
  }
  if (err instanceof SeclaiAPIStatusError) {
    const { statusCode } = err;
    if (statusCode === 401 || statusCode === 403) {
      return jsonError(
        502,
        "The Seclai API rejected the server's credentials. Check SECLAI_API_KEY.",
      );
    }
    if (statusCode >= 400 && statusCode < 500) {
      return jsonError(
        statusCode,
        upstreamMessage(err.responseText) ??
          `The Seclai API returned status ${statusCode}.`,
      );
    }
    return jsonError(502, `The Seclai API returned status ${statusCode}.`);
  }
  if (err instanceof SeclaiStreamingError) {
    return jsonError(504, "Timed out waiting for the Seclai API.");
  }
  return jsonError(502, "Could not reach the Seclai API.");
}

/** Message for an `event: error` frame sent after the stream has started. */
export function streamErrorMessage(err: unknown): string {
  if (err instanceof SeclaiStreamingError) {
    return "Timed out waiting for the agent run to finish.";
  }
  return "The connection to the Seclai API was lost.";
}

/**
 * Log fields for anything thrown while calling the SDK: the upstream status
 * and the API's message where there is one, so the server log shows the cause
 * that a 502 hides from the browser.
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof SeclaiAPIStatusError) {
    return {
      upstream_status: err.statusCode,
      error: upstreamMessage(err.responseText) ?? err.message,
    };
  }
  if (err instanceof Error) return { error: err.message };
  return { error: String(err) };
}
