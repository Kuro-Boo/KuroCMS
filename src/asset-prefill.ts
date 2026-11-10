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
