// URL カードのリッチ表示（unfurl）— サーバー側メタ取得・署名・SSRF ガード。
// api.ts（公開エンドポイント）と public.ts（ビルド時のカード署名）の両方から使う
// 共有モジュール（循環 import 回避）。取得メタは保存せず表示専用（原本は [[url|]]）。
import type { Env } from "./types";
import { randomToken } from "./crypto";

export interface UnfurlMeta {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
}

export type UnfurlResult =
  | { ok: true; meta: UnfurlMeta }
  | {
      ok: false;
      reason: "target_404" | "target_unreachable" | "invalid_url" | "forbidden";
    };

// ── URL-safe base64（署名のクエリ受け渡し用）─────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 署名（ビルドが「公開コンテンツに実在した URL」だけを許可する）───────────
// 目的: /api/unfurl をオープンプロキシにしないため、「公開コンテンツに実在した
// URL」だけを HMAC 署名で許可する。鍵はサーバー側の非公開な安定値であれば何でも
// よい。
//
// 【なぜ専用鍵にしたか】以前は鍵を env.KUROCMS_AND_KUROMAILER_PAT（メール用の
// 共有 Secret）から派生していた。「新規 Secret を設定させたくない」ため既存の
// Secret を流用したものだが、KuroMailer は未設定時に埋め込み定数へフォールバック
// するので、この env Secret は【ほとんどのインストールで未設定】。結果 unfurlSign
// が空文字を返し、公開ページのカードに署名が付かず、リッチ化が黙って無効化されて
// いた（エディタは Author 認証なので動くが公開だけ簡易表示、という不一致）。加えて
// カード表示とメールという無関係な機能が 1 つの Secret に相乗りしていた。
//
// そこで unfurl 専用のランダム鍵を KV に一度だけ自動生成・保存して使う。ユーザー
// 設定は不要、鍵は非公開（KV は外部露出しない）、メールとは完全に分離。埋め込み
// 定数を鍵にする案は不可 — 公開ミラーに載っているので署名を誰でも偽造できてしまう。
const UNFURL_KEY_KV = "unfurl:sigkey:v2";
// per-isolate キャッシュ。KV 値はインストール毎に安定なので使い回してよい
// （injectKuroLinksClient がページ内 URL 数だけ unfurlSign を呼ぶ際の KV 読みを削減）。
let cachedKeyMaterial: string | null = null;

async function unfurlKeyMaterial(env: Env): Promise<string | null> {
  if (cachedKeyMaterial) return cachedKeyMaterial;
  if (!env.PUBLIC_PAGES) return null;
  let material = (await env.PUBLIC_PAGES.get(UNFURL_KEY_KV)) || "";
  if (!material) {
    material = randomToken();
    await env.PUBLIC_PAGES.put(UNFURL_KEY_KV, material);
  }
  cachedKeyMaterial = material;
  return material;
}

async function sigKey(env: Env): Promise<CryptoKey | null> {
  const material = await unfurlKeyMaterial(env);
  if (!material) return null;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("kurocms-unfurl-v2:" + material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function unfurlSign(env: Env, url: string): Promise<string> {
  const key = await sigKey(env);
  if (!key) return "";
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(url),
  );
  return b64url(new Uint8Array(sig));
}

export async function unfurlVerify(
  env: Env,
  url: string,
  sig: string,
): Promise<boolean> {
  if (!sig || !url) return false;
  const key = await sigKey(env);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(url),
    );
  } catch {
    return false;
  }
}

// ── SSRF ガード: http(s) の公開ホストのみ許可（内部/私設/メタデータ IP を遮断）─
export function unfurlUrlAllowed(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
  // IPv6 リテラル / 0.0.0.0 は保守的に遮断（unfurl 対象は名前付きホスト想定）。
  if (host.includes(":") || host === "0.0.0.0") return null;
  // IPv4 リテラル: ループバック/私設/リンクローカル/メタデータ/CGNAT/マルチキャスト。
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return null;
    }
  }
  return u;
}

// ── HTML から OG/title/favicon を抽出（DOM 無し・正規表現）─────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function firstMatch(html: string, res: RegExp[]): string | undefined {
  for (const re of res) {
    const m = re.exec(html);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return undefined;
}

export function extractUnfurlMeta(html: string, base: URL): UnfurlMeta {
  const head = html.slice(0, 100_000); // メタは <head> にある
  const title =
    firstMatch(head, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
      /<title[^>]*>([^<]*)<\/title>/i,
    ]) || "";
  const description = firstMatch(head, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const rawImage = firstMatch(head, [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const rawFav = firstMatch(head, [
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']*)["']/i,
    /<link[^>]+href=["']([^"']*)["'][^>]+rel=["'][^"']*icon[^"']*["']/i,
  ]);
  const toAbs = (u?: string): string | undefined => {
    if (!u) return undefined;
    try {
      const abs = new URL(u, base).toString();
      return /^https?:\/\//i.test(abs) ? abs : undefined;
    } catch {
      return undefined;
    }
  };
  const meta: UnfurlMeta = {};
  if (title) meta.title = title.slice(0, 300);
  if (description) meta.description = description.slice(0, 500);
  const image = toAbs(rawImage);
  if (image) meta.image = image;
  const favicon = toAbs(rawFav || "/favicon.ico");
  if (favicon) meta.favicon = favicon;
  return meta;
}

// ── fetch + パース（SSRF・タイムアウト・サイズ上限つき）──────────────────
export async function fetchUnfurl(rawUrl: string): Promise<UnfurlResult> {
  const u = unfurlUrlAllowed(rawUrl);
  if (!u) return { ok: false, reason: "invalid_url" };
  let resp: Response;
  try {
    resp = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "KuroCMS-unfurl/1.0 (+https://kuro.boo/kurocms)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: "target_unreachable" };
  }
  if (resp.status === 404 || resp.status === 410)
    return { ok: false, reason: "target_404" };
  if (!resp.ok) return { ok: false, reason: "target_unreachable" };
  const ct = resp.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    // 直リンク画像/PDF 等 — OG メタは無いが到達可能。
    return { ok: true, meta: {} };
  }
  const reader = resp.body?.getReader();
  if (!reader) return { ok: true, meta: {} };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const MAX = 512 * 1024;
  try {
    while (size < MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.byteLength;
      }
    }
    await reader.cancel().catch(() => {});
  } catch {
    return { ok: false, reason: "target_unreachable" };
  }
  const total = Math.min(size, MAX);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, total - off);
    buf.set(c.subarray(0, n), off);
    off += n;
    if (off >= total) break;
  }
  const html = new TextDecoder("utf-8").decode(buf);
  return {
    ok: true,
    meta: extractUnfurlMeta(html, new URL(resp.url || u.toString())),
  };
}
