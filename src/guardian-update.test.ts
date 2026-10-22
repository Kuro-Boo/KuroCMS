// Contract test: 番人(WorkerOps)の更新は app が行う(cms-workerops・guardian-update.ts)。
// Cloudflare と番人の受け口は偽物で置き換え、こちらの手順(鍵・上げ方・確かめ・戻し・前方のみ・
// 自動更新の起こし方)を固定する。
import {
  adoptGuardianMinute,
  guardianAutoTick,
  guardianBindings,
  guardianInfo,
  guardianUpdate,
  type GuardianDeps,
} from "./guardian-update.ts";
import type { Env } from "./types";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`  ${g === w ? "ok  " : "FAIL"} ${name}`);
  if (g !== w) {
    failed++;
    console.log(`    got : ${g}\n    want: ${w}`);
  }
};

interface World {
  env: Env;
  kv: Map<string, string>;
  calls: string[];
  deployed: string[];
  uploads: Array<{ bindings: unknown[] }>;
  deps: GuardianDeps;
  /** 番人が今名乗る版(null = 受け口の無い古い番人)。 */
  peer: { version: string | null; holdOk: boolean; held: boolean };
  clock: { t: number };
}

function world(
  opts: {
    peer?: string | null;
    channels?: { stable: string; dev: string };
    /** 上げた版が名乗るか。false なら旧版のまま答え続ける。 */
    newAnswers?: boolean;
    holdOk?: boolean;
    kv?: Record<string, string>;
    appVersion?: string;
    noBinding?: boolean;
    /** 委託の app(Cloudflare の鍵を持たない)。 */
    noToken?: boolean;
    /** cron の付け替えが Cloudflare に断られる。 */
    schedulesFail?: boolean;
  } = {},
): World {
  const kv = new Map<string, string>(Object.entries(opts.kv ?? {}));
  const calls: string[] = [];
  const deployed: string[] = [];
  const uploads: Array<{ bindings: unknown[] }> = [];
  const clock = { t: 1_800_000_000_000 };
  const peer = {
    version: opts.peer === undefined ? "0.1.23" : opts.peer,
    holdOk: opts.holdOk ?? true,
    held: false,
  };
  const channels = opts.channels ?? { stable: "0.1.24", dev: "0.1.25" };
  let uploadedVersion = "";
  const versionIds: Record<string, string> = {};

  const binding = {
    publish: async () => ({ ok: true, status: "published" }),
    status: async () => {
      if (!peer.version)
        throw new Error(
          'The RPC receiver does not implement the method "status".',
        );
      return {
        service: "workerops",
        version: peer.version,
        state: "confirmed",
        selfUpdate: false,
        locked: peer.held,
      };
    },
    hold: async () => {
      calls.push("hold");
      if (!peer.holdOk) return { ok: false, reason: "busy" };
      peer.held = true;
      return { ok: true };
    },
    release: async () => {
      calls.push("release");
      peer.held = false;
    },
  };

  const env = {
    PUBLIC_PAGES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    WORKEROPS: opts.noBinding ? undefined : binding,
    CF_API_TOKEN: opts.noToken ? undefined : "tok",
    CF_ACCOUNT_ID: "acct",
    CF_WORKER_NAME: "kurocms-app",
  } as unknown as Env;

  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const cfFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace(
      "https://api.cloudflare.com/client/v4/accounts/acct",
      "",
    );
    calls.push(`${method} ${path}`);
    if (path.endsWith("/schedules") && method === "PUT") {
      if (opts.schedulesFail)
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "denied" }],
          }),
          { status: 403 },
        );
      calls.push(`  ${String(init!.body)}`);
      return ok({});
    }
    if (path === "/workers/scripts/kurocms-app/settings")
      return ok({
        bindings: [
          {
            type: "service",
            name: "WORKEROPS",
            service: "kurocms-ops",
            entrypoint: "WorkerOpsAssets",
          },
        ],
      });
    if (path === "/workers/scripts/kurocms-ops/settings")
      return ok({
        compatibility_date: "2025-01-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
          {
            type: "kv_namespace",
            name: "WORKEROPS_STATE",
            namespace_id: "kv1",
          },
          { type: "secret_text", name: "CF_API_TOKEN" },
          { type: "secret_text", name: "WORKER_OPS_TOKEN" },
          { type: "plain_text", name: "SELF_UPDATE", text: "1" },
          { type: "images", name: "IMG" },
        ],
      });
    if (path === "/workers/scripts/kurocms-ops/deployments" && method === "GET")
      return ok({
        deployments: [{ versions: [{ version_id: "v-old", percentage: 100 }] }],
      });
    if (path === "/workers/scripts/kurocms-ops/versions" && method === "POST") {
      const form = init!.body as FormData;
      const meta = JSON.parse(await (form.get("metadata") as Blob).text());
      uploads.push({ bindings: meta.bindings });
      versionIds["v-new"] = uploadedVersion;
      return ok({ id: "v-new" });
    }
    if (
      path === "/workers/scripts/kurocms-ops/deployments" &&
      method === "POST"
    ) {
      const body = JSON.parse(String(init!.body));
      const id = body.versions[0].version_id as string;
      deployed.push(id);
      // 出した版が名乗る(newAnswers=false なら、上げた版は名乗らない)。
      if (id === "v-new" && (opts.newAnswers ?? true))
        peer.version = uploadedVersion;
      return ok({});
    }
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 7003, message: "no route" }],
      }),
      { status: 404 },
    );
  }) as typeof fetch;

  const deps: GuardianDeps = {
    fetch: cfFetch,
    sleep: async (ms) => void (clock.t += ms),
    now: () => clock.t,
    report: async (code, detail) =>
      void calls.push(`report ${code} ${detail.reason ?? ""}`.trim()),
    appVersion: opts.appVersion ?? "1.10.50",
    channelVersion: async (c) => channels[c],
    fetchCode: async (v) => {
      calls.push(`fetchCode ${v}`);
      uploadedVersion = v;
      return {
        mainModule: "worker.js",
        code: new TextEncoder().encode("export default {}")
          .buffer as ArrayBuffer,
      };
    },
  };
  return { env, kv, calls, deployed, uploads, deps, peer, clock };
}

const main = async () => {
  // ── 上げる ──
  {
    const w = world();
    const r = await guardianUpdate(w.env, w.deps, "manual");
    eq(
      "安定版(0.1.24)へ上げ、新しい版が名乗れば updated",
      [r.outcome, r.from, r.to],
      ["updated", "0.1.23", "0.1.24"],
    );
    eq(
      "鍵を取ってから上げ、最後に返す",
      [w.calls[0], w.calls.at(-1)],
      ["hold", "release"],
    );
    eq("上げた版だけを出す(戻さない)", w.deployed, ["v-new"]);
    eq(
      "成功は記録として送る",
      w.calls.includes("report guardian_update_ok"),
      true,
    );
    eq(
      "結果を画面の 1 行のために残す",
      JSON.parse(w.kv.get("system:guardian_last")!).outcome,
      "updated",
    );
  }
  {
    const b = guardianBindings([
      { type: "secret_text", name: "CF_API_TOKEN" },
      { type: "plain_text", name: "SELF_UPDATE", text: "1" },
      { type: "images", name: "IMG" },
      { type: "inherit", name: "WORKER_OPS_TOKEN" },
    ]);
    eq("binding: secret は inherit、知らない型も落とさず、自己更新は切る", b, [
      { type: "inherit", name: "CF_API_TOKEN" },
      { type: "images", name: "IMG" },
      { type: "inherit", name: "WORKER_OPS_TOKEN" },
      { type: "plain_text", name: "SELF_UPDATE", text: "0" },
      { type: "plain_text", name: "APP_TICK", text: "1" },
    ]);
  }
  {
    const w = world({ kv: { "system:guardian_channel": "latest" } });
    const r = await guardianUpdate(w.env, w.deps, "manual");
    eq("最新版のチャンネルなら update の dev(0.1.25)", r.to, "0.1.25");
    eq(
      "上げた版の binding に自己更新の切が入る",
      (w.uploads[0].bindings as Array<{ name: string; text?: string }>).find(
        (x) => x.name === "SELF_UPDATE",
      )?.text,
      "0",
    );
  }
  // ── 前方のみ ──
  {
    const w = world({ peer: "0.1.24" });
    const r = await guardianUpdate(w.env, w.deps, "manual");
    eq(
      "同じ版なら何もしない(鍵も取らない)",
      [r.outcome, w.calls.includes("hold"), w.deployed],
      ["up_to_date", false, []],
    );
  }
  {
    const w = world({ peer: "0.1.30" });
    eq(
      "新しい版を使っていれば下げない",
      (await guardianUpdate(w.env, w.deps, "manual")).outcome,
      "up_to_date",
    );
  }
  // ── 重ならない ──
  {
    const w = world({ holdOk: false });
    const r = await guardianUpdate(w.env, w.deps, "auto");
    eq(
      "番人が鍵を断ったら busy で、何も上げない",
      [r.outcome, w.deployed, w.calls.includes("release")],
      ["busy", [], false],
    );
    eq(
      "busy は結果として残さない(次の分にやり直す)",
      w.kv.has("system:guardian_last"),
      false,
    );
  }
  // ── 戻す ──
  {
    const w = world({ newAnswers: false });
    const r = await guardianUpdate(w.env, w.deps, "manual");
    eq(
      "新しい版が 60 秒名乗らなければ、前の版の ID へ戻す",
      [r.outcome, w.deployed],
      ["rolled_back", ["v-new", "v-old"]],
    );
    eq(
      "戻したことを不具合として送る",
      w.calls.includes("report guardian_update_rolled_back verify_timeout"),
      true,
    );
    eq("戻しても鍵は返す", w.calls.at(-1), "release");
  }
  // ── 古い番人(受け口が無い) ──
  {
    const w = world({ peer: null });
    const info = await guardianInfo(w.env, w.deps);
    eq(
      "古い番人: 版は —(null)、更新できるものとして扱う",
      [info.current, info.legacy, info.hasUpdate],
      [null, true, true],
    );
    const r = await guardianUpdate(w.env, w.deps, "manual");
    eq(
      "古い番人: 鍵は取れないが上げ、新しい版の status() で確かめる",
      [r.outcome, r.from, w.calls.includes("hold")],
      ["updated", null, false],
    );
  }
  {
    const w = world({
      peer: null,
      channels: { stable: "0.1.22", dev: "0.1.22" },
    });
    const info = await guardianInfo(w.env, w.deps);
    eq(
      "古い番人: 受け口の無い版(0.1.22)しか無ければ、更新は無いと出す",
      info.hasUpdate,
      false,
    );
    const r = await guardianUpdate(w.env, w.deps, "auto");
    eq(
      "古い番人: 受け口の無い版へは上げない(確かめられず毎回戻すことになる)",
      [r.outcome, w.deployed],
      ["up_to_date", []],
    );
  }
  // ── 繋がっていない導入 ──
  {
    const w = world({ noBinding: true });
    const info = await guardianInfo(w.env, w.deps);
    eq(
      "binding が無ければ、その旨を返す",
      [info.available, info.reason],
      [false, "no_binding"],
    );
    eq(
      "binding が無ければ上げない",
      (await guardianUpdate(w.env, w.deps, "manual")).outcome,
      "unavailable",
    );
  }
  // ── 自動更新の起こし方 ──
  {
    const w = world({
      appVersion: "1.10.50",
      kv: {
        "system:guardian_seen": JSON.stringify({
          app: "1.10.50",
          at: 0,
          done: true,
        }),
      },
    });
    eq(
      "自動: app の版が同じ間は何もしない",
      await guardianAutoTick(w.env, w.deps),
      null,
    );
    eq("自動: そのとき CF にも番人にも触らない", w.calls, []);
  }
  {
    const w = world({
      appVersion: "1.10.51",
      kv: {
        "system:guardian_seen": JSON.stringify({
          app: "1.10.50",
          at: 0,
          done: true,
        }),
      },
    });
    const r = await guardianAutoTick(w.env, w.deps);
    eq("自動: app の版が変わったら番人を上げる", r?.outcome, "updated");
    const seen = JSON.parse(w.kv.get("system:guardian_seen")!);
    eq("自動: 済んだことを残す", [seen.app, seen.done], ["1.10.51", true]);
  }
  {
    const w = world({ appVersion: "1.10.51", holdOk: false });
    const r = await guardianAutoTick(w.env, w.deps);
    eq(
      "自動: busy なら済んだことにしない(次の分にやり直す)",
      [r?.outcome, JSON.parse(w.kv.get("system:guardian_seen")!).done],
      ["busy", false],
    );
  }
  {
    const w = world({
      appVersion: "1.10.51",
      kv: { "system:guardian_auto": "0" },
    });
    eq(
      "自動: 切なら何もしない",
      [await guardianAutoTick(w.env, w.deps), w.calls],
      [null, []],
    );
  }
  {
    const w = world({ appVersion: "1.10.51", peer: null });
    eq(
      "自動・古い番人: 版が変わってすぐは待つ(番人が app を確かめている)",
      await guardianAutoTick(w.env, w.deps),
      null,
    );
    w.clock.t += 3 * 60_000;
    eq(
      "自動・古い番人: 3 分たったら上げる",
      (await guardianAutoTick(w.env, w.deps))?.outcome,
      "updated",
    );
  }

  // ── cron を番人の 1 本にまとめる(adoptGuardianMinute・core-offering 11 節) ──
  {
    const w = world({ noToken: true });
    await adoptGuardianMinute(w.env, w.deps);
    eq("委託の app(鍵が無い)は何もしない(切り替えは導入口)", w.calls, []);
  }
  {
    const w = world({ schedulesFail: true });
    const err = await adoptGuardianMinute(w.env, w.deps).then(
      () => null,
      (e) => String(e),
    );
    eq(
      "付け替えが断られたら投げ、印は残さない",
      [!!err, w.kv.has("system:guardian_minute")],
      [true, false],
    );
    w.calls.length = 0;
    await adoptGuardianMinute(w.env, w.deps);
    eq("断られた後 1 時間は試し直さない(毎分 API を叩かない)", w.calls, []);
  }
  {
    const w = world();
    w.clock.t += 3600_001;
    await adoptGuardianMinute(w.env, w.deps);
    eq("顧客導入: 番人を毎分にしてから、自分の cron を外す(この順)", w.calls, [
      "GET /workers/scripts/kurocms-app/settings",
      "PUT /workers/scripts/kurocms-ops/schedules",
      `  ${JSON.stringify([{ cron: "* * * * *" }])}`,
      "PUT /workers/scripts/kurocms-app/schedules",
      "  []",
    ]);
    eq("済んだ印を残す", w.kv.get("system:guardian_minute"), "1");
    w.calls.length = 0;
    await adoptGuardianMinute(w.env, w.deps);
    eq("済んだら二度としない", w.calls, []);
  }

  if (failed) {
    console.log(`\n${failed} 件失敗`);
    process.exit(1);
  }
};
main();
