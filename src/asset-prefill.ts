// 更新の時点で、その版の管理画面の部品を KV へ取り寄せておく(2026-11-11・利用者の決定)。
//
// 以前は、新しい版の部品を**最初に開いた人の要求の中で**配布基盤から取っていた(asset-serve.ts)。
// 取り寄せが詰まると、その人の管理画面は「Now Loading」のまま開かなかった。
// 名前は中身の hash なので、先に置いても動いている版を壊さない。既に KV にあるものは取り直さない。
// 取れなかったものは、これまでどおり開いた時に取る。
import type { ReleaseEvent, ReleaseEventDetail } from "./release-report.ts";
import { reasonOf, type UpdateManifest } from "./release-source.ts";

export const ASSET_RE =
  /^(admin-app|ke|ke-content|kuro-links|kuro-code-copy|kuro-head|kuro-site|html2canvas)\.[a-z0-9.]+\.(js|css)$/;
export const KV_PREFIX = "admin:asset:";

export type PrefillResult = { filled: number; kept: number; failed: number };

export interface PrefillKv {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer): Promise<void>;
}

export interface PrefillDeps {
  /** 確かめ(sha256)の済んだ中身。 */
  fetchArtifact(name: string): Promise<ArrayBuffer>;
  report(code: ReleaseEvent, detail: ReleaseEventDetail): Promise<void>;
}

export async function prefillAssets(
  kv: PrefillKv,
  manifest: UpdateManifest,
  deps: PrefillDeps,
): Promise<PrefillResult> {
  const names = manifest.artifacts
    .map((a) => a.name)
    .filter((n) => ASSET_RE.test(n));
  const r: PrefillResult = { filled: 0, kept: 0, failed: 0 };
  for (const name of names) {
    const key = KV_PREFIX + name;
    try {
      if (await kv.get(key, "arrayBuffer")) {
        r.kept++;
        continue;
      }
      await kv.put(key, await deps.fetchArtifact(name));
      r.filled++;
    } catch (err) {
      r.failed++;
      await deps.report("release_update_failed", {
        what: "asset_prefill",
        version: manifest.version,
        asset: name,
        reason: reasonOf(err),
      });
    }
  }
  await deps.report("release_update_ok", {
    what: "asset_prefill",
    version: manifest.version,
    ...r,
  });
  return r;
}

/**
 * その版の部品がそろった印(2026-11-21)。これがある間は、毎分の確かめが KV を 1 回読むだけで済む。
 * 導入口(CoreSystem/Install の deployer.ts)も、導入の時に部品を置いた後でこの印を置く —— 名前を変えるときは両方を直す。
 */
export const READY_PREFIX = "admin:asset:ready:";

export type EnsureResult = PrefillResult & { ready: boolean };

/**
 * 自分の版の部品を、そろうまで取り寄せる(状態で決める: 印があれば何もしない・無ければ取りそろえ、
 * 1 つも落ちなければ印を置く)。毎分の刻み・番人の migrate・部品の要求の取りこぼしから呼ぶ。
 * ⚠ 部品を頼んだ人の要求の中で待たない。そこで待つと、配布基盤の返事が遅いあいだ管理画面が
 *   「Now Loading」のまま固まる(2026-11-21・新しい導入で 10 分ほど開かなかった)。
 */
export async function ensureAssets(
  kv: PrefillKv,
  version: string,
  loadManifest: () => Promise<UpdateManifest>,
  deps: PrefillDeps,
): Promise<EnsureResult> {
  const readyKey = READY_PREFIX + version;
  if (await kv.get(readyKey, "arrayBuffer"))
    return { ready: true, filled: 0, kept: 0, failed: 0 };
  const r = await prefillAssets(kv, await loadManifest(), deps);
  const ready = r.failed === 0;
  if (ready)
    await kv.put(readyKey, new TextEncoder().encode("1").buffer as ArrayBuffer);
  return { ...r, ready };
}

/** 同じ isolate の中で、取りそろえを同時に 2 本走らせない(要求が重なっても 1 本にまとめる)。 */
const inFlight = new Map<string, Promise<EnsureResult>>();
export function ensureOnce(
  key: string,
  run: () => Promise<EnsureResult>,
): Promise<EnsureResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
