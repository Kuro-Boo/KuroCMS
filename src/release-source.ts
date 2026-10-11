/**
 * 版の取り先 —— GitHub Release か、Entamy の配布基盤(update)か(仕様 cms-release・2026-10-11)。
 *
 * KuroCMS は GitHub Release から配布基盤へ移る途中にある。移り終わるまで(1 年以上)**両方へ出し**、
 * 取るのは update から(既定・2026-10-12)。取れなければ GitHub へ落ち、結果は Defects へ送る。
 * 導入ごとに github だけへ戻すこともできる(PUT /api/system/release-source)。
 *
 * update から取るときは、
 *   ① チャンネルの指す版を読み(stable → stable、latest → dev)
 *   ② 版の manifest の**署名を手元の公開鍵で確かめ**(鍵はここに持つ。公開鍵なので隠さない)
 *   ③ 成果物を sha256 と大きさで manifest に照らす
 * —— 配布基盤が侵されても、確かめの通らないバイト列は入れない。
 *
 * 版に入っているもの: worker.js・migrations-manifest.json・管理画面のアセット(admin-app.*.js など)。
 */
import type { Env } from "./types";

export const UPDATE_ORIGIN = "https://update.entamy.com";
export const UPDATE_PRODUCT = "cms";
const SOURCE_KEY = "system:release_source";
const FALLBACK_KEY = "system:release_source_fallback";

/**
 * 発行の署名を確かめる公開鍵(Entamy/.env の ENTAMY_RELEASE_PUBKEYS と同じ)。
 * 鍵を替えるときは新旧を並べ、古い版が確かめられなくならないようにする。
 */
const RELEASE_PUBKEYS: { key_id: string; pub: string }[] = [
  {
    key_id: "release-b01a61a2",
    pub: "oSIheWqY73pJf85mtBNC4N7pAM8_aSpnCzVNcZ4INps",
  },
];

export type ReleaseSource = "github" | "update";

/**
 * 既定は update(2026-10-12)。GitHub Release への並行の公開は 1 年以上続けるが、取るのは
 * 最新の版から順次 update にし、取れなければ GitHub へ落ちる。結果はすべて Defects へ送る
 * (release-report)。GitHub だけから取るのは、管理者が明示的に github を選んだ導入だけ。
 */
export async function getReleaseSource(env: Env): Promise<ReleaseSource> {
  try {
    return (await env.PUBLIC_PAGES.get(SOURCE_KEY)) === "github"
      ? "github"
      : "update";
  } catch {
    return "update";
  }
}

export async function setReleaseSource(
  env: Env,
  source: unknown,
): Promise<ReleaseSource> {
  const v: ReleaseSource = source === "github" ? "github" : "update";
  await env.PUBLIC_PAGES.put(SOURCE_KEY, v);
  return v;
}

/** KuroCMS のチャンネル名 → update のチャンネル名。 */
export const updateChannelOf = (
  channel: "stable" | "latest",
): "stable" | "dev" => (channel === "latest" ? "dev" : "stable");

export interface Artifact {
  name: string;
  role?: string;
  sha256: string;
  size: number;
}
export interface UpdateManifest {
  schema: string;
  product: string;
  version: string;
  artifacts: Artifact[];
  signature: { alg: string; key_id: string; sig: string };
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 取れなかった・確かめが通らなかった理由。`reason` は Defects へ送る符号
 * (detail は符号と数値だけ —— 文は送れないので、何が起きたかは符号で言い切る)。
 */
export class ReleaseError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ReleaseError";
    this.reason = reason;
  }
}

/** 例外を Defects の符号にする。ReleaseError 以外は通信の失敗として分ける。 */
export function reasonOf(err: unknown): string {
  if (err instanceof ReleaseError) return err.reason;
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  if (err instanceof TypeError) return "unreachable";
  return "other";
}

const fromB64url = (s: string): Uint8Array => {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** CoreSystem/update/src/manifest.ts の canonical() と同一(署名する側と同じバイト列)。 */
export function canonical(m: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...m };
  delete rest.signature;
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort())
        out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(rest));
}

async function getJson(path: string): Promise<unknown> {
  const r = await fetch(UPDATE_ORIGIN + path, {
    signal: AbortSignal.timeout(15_000),
    cf: { cacheTtl: 0 },
  });
  if (r.status === 404)
    throw new ReleaseError("not_found", `not found: ${path}`);
  if (!r.ok)
    throw new ReleaseError(`http_${r.status}`, `HTTP ${r.status}: ${path}`);
  return r.json();
}

/** チャンネルの指す版(X.Y.Z)。 */
export async function updateChannelVersion(
  channel: "stable" | "dev",
): Promise<string> {
  const p = (await getJson(
    `/v1/dist/${UPDATE_PRODUCT}/channels/${channel}.json`,
  )) as { product_id?: string; version?: string };
  if (p.product_id !== UPDATE_PRODUCT || !VERSION_RE.test(p.version ?? ""))
    throw new ReleaseError("bad_pointer", "channel pointer is invalid");
  return p.version!;
}

/** 版の manifest。**署名を確かめてから**返す。 */
export async function fetchUpdateManifest(
  version: string,
): Promise<UpdateManifest> {
  if (!VERSION_RE.test(version))
    throw new ReleaseError("bad_version", "version is invalid");
  const m = (await getJson(
    `/v1/dist/${UPDATE_PRODUCT}/${version}/manifest.json`,
  )) as UpdateManifest;
  if (
    !m ||
    m.product !== UPDATE_PRODUCT ||
    m.version !== version ||
    !Array.isArray(m.artifacts)
  ) {
    throw new ReleaseError(
      "identity_mismatch",
      "release identity does not match",
    );
  }
  if (!m.signature || m.signature.alg !== "ed25519")
    throw new ReleaseError("signature_missing", "release signature is missing");
  const trusted = RELEASE_PUBKEYS.find((k) => k.key_id === m.signature.key_id);
  if (!trusted)
    throw new ReleaseError(
      "untrusted_key",
      "release signing key is not trusted",
    );
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(trusted.pub),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    fromB64url(m.signature.sig),
    new TextEncoder().encode(
      canonical(m as unknown as Record<string, unknown>),
    ),
  );
  if (!ok)
    throw new ReleaseError(
      "signature_mismatch",
      "release signature does not match",
    );
  return m;
}

/** 成果物の中身。sha256 と大きさを manifest に照らす(圧縮して置かれていれば解く)。 */
export async function fetchUpdateArtifact(
  manifest: UpdateManifest,
  name: string,
): Promise<ArrayBuffer> {
  const a = manifest.artifacts.find((x) => x.name === name);
  if (!a)
    throw new ReleaseError(
      "artifact_missing",
      `${name} is not in release ${manifest.version}`,
    );
  const r = await fetch(
    `${UPDATE_ORIGIN}/v1/dist/${UPDATE_PRODUCT}/blobs/${a.sha256}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!r.ok || !r.body)
    throw new ReleaseError(
      `http_${r.status}`,
      `${name} fetch failed: HTTP ${r.status}`,
    );
  const body =
    r.headers.get("x-entamy-encoding") === "gzip"
      ? r.body.pipeThrough(new DecompressionStream("gzip"))
      : r.body;
  const buf = await new Response(body).arrayBuffer();
  if (buf.byteLength !== a.size)
    throw new ReleaseError("size_mismatch", `${name} size does not match`);
  if (hex(await crypto.subtle.digest("SHA-256", buf)) !== a.sha256)
    throw new ReleaseError("digest_mismatch", `${name} digest does not match`);
  return buf;
}

/**
 * update から取れずに GitHub へ落ちたことを残す(並行の間だけの退路)。
 * **黙って落ちない** —— カナリアの目的は update の経路の不具合を見つけることなので、
 * 落ちた事実を版の画面(/api/system/version)に出す。
 */
export async function noteFallback(
  env: Env,
  what: string,
  error: unknown,
): Promise<void> {
  const detail = {
    what,
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
  console.error("release source fallback", detail);
  try {
    await env.PUBLIC_PAGES.put(FALLBACK_KEY, JSON.stringify(detail), {
      expirationTtl: 30 * 24 * 3600,
    });
  } catch {
    /* 記録できなくても続ける */
  }
}

export async function lastFallback(
  env: Env,
): Promise<Record<string, string> | null> {
  try {
    const v = await env.PUBLIC_PAGES.get(FALLBACK_KEY);
    return v ? (JSON.parse(v) as Record<string, string>) : null;
  } catch {
    return null;
  }
}
