import type { ApiErrorBody, JsonValue } from "./types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(
        400,
        "invalid_json",
        "Request body must be a JSON object.",
      );
    }
    return value as T;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function json(data: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  // The app shell references hashed asset bundles (admin-app.<hash>.js,
  // ke.<ver>.js). Never let the browser reuse stale shell HTML, or after a
  // deploy it will request asset hashes that no longer exist and the admin/
  // editor fails to load until a manual reload. Always revalidate.
  if (!headers.has("cache-control"))
    headers.set("cache-control", "no-cache, must-revalidate");
  return new Response(body, { ...init, headers });
}

export function notFound(): Response {
  return jsonError(404, "not_found", "The requested resource was not found.");
}

// A browser navigating to a stray/typo'd URL (e.g. an old bookmark, a scanned
// QR code) previously got the raw notFound() JSON body — Safari/Chrome can't
// render that, so mobile browsers offer it as a "download" (looks broken).
// Only requests that actually ask for HTML get this page; fetch()/XHR clients
// (Accept: application/json or none) keep getting the plain JSON error.
export function notFoundPage(
  request: Request,
  links: { homeHref: string; adminHref: string },
): Response {
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) return notFound();
  const body = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 Not Found</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0f172a; color:#f1f5f9; font-family:ui-sans-serif,system-ui,sans-serif; }
  .box { text-align:center; padding:24px; }
  h1 { font-size:15px; font-weight:800; letter-spacing:0.08em; color:#64748b; margin:0 0 8px; }
  p { font-size:15px; color:#94a3b8; margin:0 0 24px; }
  a { display:inline-block; margin:0 8px; padding:10px 18px; border-radius:8px; background:#334155; color:#f1f5f9; text-decoration:none; font-weight:700; font-size:14px; }
  a:hover { filter:brightness(1.15); }
</style>
</head>
<body>
  <div class="box">
    <h1>404 NOT FOUND</h1>
    <p>The requested page was not found.</p>
    <a href="${links.homeHref}">Site</a>
    <a href="${links.adminHref}">Admin</a>
  </div>
</body>
</html>`;
  return html(body, { status: 404 });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  const body: ApiErrorBody = {
    error: { code, message },
  };
  return json(body as unknown as JsonValue, { status });
}

export function requireString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `${key} must be a string.`);
  }
  const trimmed = value.trim();
  if (options.min !== undefined && trimmed.length < options.min) {
    throw new HttpError(400, "invalid_field", `${key} is too short.`);
  }
  if (options.max !== undefined && trimmed.length > options.max) {
    throw new HttpError(400, "invalid_field", `${key} is too long.`);
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `${key} must be a string.`);
  }
  return value.trim();
}

export function requireSlug(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_slug",
      `${label} must use lowercase letters, numbers, and hyphens.`,
    );
  }
  return value;
}
