/**
 * 版の取り先 —— Entamy の配布基盤(update)だけ(仕様 cms-release・2026-11-05 に GitHub Release をやめた)。
 *
 * 取るときは、
 *   ① チャンネルの指す版を読み(stable → stable、latest → dev)
 *   ② 版の manifest の**署名を手元の公開鍵で確かめ**(鍵はここに持つ。公開鍵なので隠さない)
 *   ③ 成果物を sha256 と大きさで manifest に照らす
 * —— 配布基盤が侵されても、確かめの通らないバイト列は入れない。
 *
 * 版に入っているもの: worker.js・migrations-manifest.json・管理画面のアセット(admin-app.*.js など)。
 * 番人(WorkerOps)の版も同じ鍵・同じ確かめ方で取る(product = "workerops"・guardian-update.ts)。
 */

export const UPDATE_ORIGIN = "https://update.entamy.com";
export const UPDATE_PRODUCT = "cms";

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

/**
 * 開発版を取るときのトークン(release-token.ts)。開発版は開発アカウントのサイトにだけ渡され、
 * ほかには 404 が返る(core-feature-flags 2節)。無ければ公開の版だけを取る。
 */
export type ReleaseToken = () => Promise<string | null>;

/** まず公開の口で取り、404 ならトークンを添えてもう一度だけ見る。安定版の取得はトークンに頼らない。 */
async function distFetch(
  url: string,
  init: RequestInit,
  token?: ReleaseToken,
): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 404 || !token) return first;
  const t = await token();
  if (!t) return first;
  return fetch(url, { ...init, headers: { authorization: `Bearer ${t}` } });
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

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
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

async function getJson(path: string, token?: ReleaseToken): Promise<unknown> {
  const r = await distFetch(
    UPDATE_ORIGIN + path,
    {
      signal: AbortSignal.timeout(15_000),
      cf: { cacheTtl: 0 },
    } as RequestInit,
    token,
  );
  if (r.status === 404)
    throw new ReleaseError("not_found", `not found: ${path}`);
  if (!r.ok)
    throw new ReleaseError(`http_${r.status}`, `HTTP ${r.status}: ${path}`);
  return r.json();
}

/** チャンネルの指す版(X.Y.Z)。 */
export async function updateChannelVersion(
  channel: "stable" | "dev",
  product: string = UPDATE_PRODUCT,
  token?: ReleaseToken,
): Promise<string> {
  const p = (await getJson(
    `/v1/dist/${product}/channels/${channel}.json`,
    token,
  )) as {
    product_id?: string;
    version?: string;
  };
  if (p.product_id !== product || !VERSION_RE.test(p.version ?? ""))
    throw new ReleaseError("bad_pointer", "channel pointer is invalid");
  return p.version!;
}

/** 版の manifest。**署名を確かめてから**返す。 */
export async function fetchUpdateManifest(
  version: string,
  product: string = UPDATE_PRODUCT,
  token?: ReleaseToken,
): Promise<UpdateManifest> {
  if (!VERSION_RE.test(version))
    throw new ReleaseError("bad_version", "version is invalid");
  const m = (await getJson(
    `/v1/dist/${product}/${version}/manifest.json`,
    token,
  )) as UpdateManifest;
  if (
    !m ||
    m.product !== product ||
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

/** バイト列を、署名つきの一覧の成果物(sha256・大きさ)に照らす。合わなければ投げる。 */
export async function checkArtifactBytes(
  manifest: UpdateManifest,
  name: string,
  buf: ArrayBuffer,
): Promise<void> {
  const a = manifest.artifacts.find((x) => x.name === name);
  if (!a)
    throw new ReleaseError(
      "artifact_missing",
      `${name} is not in release ${manifest.version}`,
    );
  if (buf.byteLength !== a.size)
    throw new ReleaseError("size_mismatch", `${name} size does not match`);
  if (hex(await crypto.subtle.digest("SHA-256", buf)) !== a.sha256)
    throw new ReleaseError("digest_mismatch", `${name} digest does not match`);
}

/** 成果物の中身。sha256 と大きさを manifest に照らす(圧縮して置かれていれば解く)。 */
export async function fetchUpdateArtifact(
  manifest: UpdateManifest,
  name: string,
  token?: ReleaseToken,
): Promise<ArrayBuffer> {
  const a = manifest.artifacts.find((x) => x.name === name);
  if (!a)
    throw new ReleaseError(
      "artifact_missing",
      `${name} is not in release ${manifest.version}`,
    );
  const r = await distFetch(
    `${UPDATE_ORIGIN}/v1/dist/${manifest.product}/blobs/${a.sha256}`,
    { signal: AbortSignal.timeout(30_000) },
    token,
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
  await checkArtifactBytes(manifest, name, buf);
  return buf;
}
