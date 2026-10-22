/**
 * 番人(WorkerOps)の更新は app が行う(仕様 cms-workerops「番人の更新は app が行う」・2026-10-16 決定)。
 *
 * 番人は app を更新し、app は番人を更新する。どちらも相手を外から確かめ、だめなら外から戻す ——
 * 番人が自分自身を入れ替える経路(自己更新)では、これができない(壊れた版に入れ替わると
 * 復旧画面ごと失われる)。だから番人を上げるときに `SELF_UPDATE` を "0" にする。
 *
 *   いつ   自動更新が入なら、app の版が変わったのを毎分の cron が見つけたとき(guardianAutoTick)。
 *          持ち主が「今すぐ更新」を押したときも同じ手順(guardianUpdate)。
 *   何を   選んだチャンネル(stable / latest → update の stable / dev)の番人の版。前方のみ。
 *   確かめ 配布基盤の manifest の署名(Ed25519)と worker.js の sha256・大きさ(release-source.ts)。
 *   重ね   番人の鍵を hold() で取ってから上げ、release() で返す(番人が app を更新しない)。
 *   検証   Service Binding で status() を聞き、新しい版が自分の版を名乗るのを待つ(60 秒まで)。
 *   戻し   上げる前に出ていた版の ID へ出し直す(番人は資産を持たないので ID で戻してよい)。
 *
 * ⚠ 受け口に status() / hold() / release() が無い古い番人(WorkerOps 0.1.22 まで)もある。
 *   版を名乗れないので「—」と出し、更新できるものとして扱う。自動更新は app の版が変わって
 *   から 3 分待つ(番人が app の確かめを終える時間。hold() で確かめられないので)。
 *   上げた後の確かめは新しい版の status() で行うので、古い番人からでも戻しまで効く。
 *
 * 外とのやり取り(fetch・報告・待ち)は deps で受ける(試験で差し替えるため)。
 */
import type { Env } from "./types";
import { reasonOf, updateChannelOf } from "./release-source.ts";

export const GUARDIAN_PRODUCT = "workerops";
const CHANNEL_KEY = "system:guardian_channel";
const AUTO_KEY = "system:guardian_auto";
const SEEN_KEY = "system:guardian_seen";
const LAST_KEY = "system:guardian_last";

/** 新しい版が名乗るのを待つ長さと間隔。 */
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_INTERVAL_MS = 3_000;
/** 番人の鍵を取る長さ。取り先・上げ・確かめ・戻しが収まる長さ(鍵は必ず切れる)。 */
const HOLD_MS = 5 * 60_000;
/** 受け口の無い古い番人のとき、app の版が変わってから待つ長さ。 */
const LEGACY_WAIT_MS = 3 * 60_000;
/**
 * 受け口(status / hold / release)が入った WorkerOps の版。これより前の版へは上げない ——
 * 上げても版を名乗れないので確かめが必ず失敗し、毎回戻すことになる。
 */
export const PEER_SINCE = "0.1.23";

export type GuardianChannel = "stable" | "latest";

export type GuardianOutcome =
  | "up_to_date"
  | "updated"
  | "rolled_back"
  | "failed"
  | "busy"
  | "unavailable";

export interface GuardianResult {
  outcome: GuardianOutcome;
  trigger: "manual" | "auto";
  from: string | null;
  to: string | null;
  /** 失敗の符号(Defects と画面に出す)。 */
  error: string | null;
  at: string;
}

export type GuardianEvent =
  | "guardian_update_ok"
  | "guardian_update_rolled_back"
  | "guardian_update_failed"
  | "guardian_rollback_failed";

export interface GuardianDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Defects へ送る。通らなくても更新は止めない。 */
  report: (
    code: GuardianEvent,
    detail: Record<string, string>,
  ) => Promise<void>;
  /** 稼働中の KuroCMS の版(KUROCMS_VERSION)。 */
  appVersion: string;
  /** 配布基盤の番人のチャンネルが指す版(X.Y.Z)。 */
  channelVersion: (channel: "stable" | "dev") => Promise<string>;
  /** 版の本体。manifest の署名と、成果物の sha256・大きさを確かめてから返す(release-source.ts)。 */
  fetchCode: (
    version: string,
  ) => Promise<{ mainModule: string; code: ArrayBuffer }>;
}

interface PeerStatus {
  service?: string;
  version?: string;
  state?: string;
  selfUpdate?: boolean;
  locked?: boolean;
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 上げる先があるか。前方のみ、かつ受け口のある版(PEER_SINCE 以降)へだけ。 */
export function canUpdate(
  current: string | null,
  target: string | null,
): boolean {
  if (!target || compareVersions(target, PEER_SINCE) < 0) return false;
  return !current || compareVersions(target, current) > 0;
}

export async function getGuardianChannel(env: Env): Promise<GuardianChannel> {
  return (await env.PUBLIC_PAGES.get(CHANNEL_KEY)) === "latest"
    ? "latest"
    : "stable";
}

export async function setGuardianChannel(
  env: Env,
  channel: unknown,
): Promise<GuardianChannel> {
  const v: GuardianChannel = channel === "latest" ? "latest" : "stable";
  await env.PUBLIC_PAGES.put(CHANNEL_KEY, v);
  return v;
}

/** 自動更新(既定は入)。 */
export async function getGuardianAuto(env: Env): Promise<boolean> {
  return (await env.PUBLIC_PAGES.get(AUTO_KEY)) !== "0";
}

export async function setGuardianAuto(
  env: Env,
  enabled: boolean,
): Promise<boolean> {
  await env.PUBLIC_PAGES.put(AUTO_KEY, enabled ? "1" : "0");
  return enabled;
}

async function lastResult(env: Env): Promise<GuardianResult | null> {
  try {
    return JSON.parse(
      (await env.PUBLIC_PAGES.get(LAST_KEY)) ?? "null",
    ) as GuardianResult | null;
  } catch {
    return null;
  }
}

/** 番人が名乗る版。受け口の無い古い番人・繋がっていない導入は null。 */
async function peerStatus(env: Env): Promise<PeerStatus | null> {
  if (!env.WORKEROPS?.status) return null;
  try {
    const s = await env.WORKEROPS.status();
    return s && s.service === "workerops" && typeof s.version === "string"
      ? s
      : null;
  } catch {
    return null;
  }
}

/**
 * 番人の版(観測の workerops_version・cms-admin-integration)。受け口の無い導入は null ——
 * 送らないだけで、Admin では「不明」になる。
 */
export async function guardianVersion(env: Env): Promise<string | null> {
  return (await peerStatus(env))?.version ?? null;
}

function missingSetup(env: Env): string | null {
  if (!env.WORKEROPS) return "no_binding";
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_WORKER_NAME)
    return "cf_creds_missing";
  return null;
}

/** ダッシュボードの WorkerOps の枠に出すもの(GET /api/system/guardian)。 */
export async function guardianInfo(
  env: Env,
  deps: GuardianDeps,
): Promise<Record<string, unknown>> {
  const channel = await getGuardianChannel(env);
  const autoUpdate = await getGuardianAuto(env);
  const last = await lastResult(env);
  const missing = missingSetup(env);
  if (missing)
    return { available: false, reason: missing, channel, autoUpdate, last };
  const status = await peerStatus(env);
  let stable: string | null = null;
  let latest: string | null = null;
  let checkOk = true;
  let checkError: string | null = null;
  try {
    [stable, latest] = await Promise.all([
      deps.channelVersion("stable"),
      deps.channelVersion("dev"),
    ]);
  } catch (err) {
    checkOk = false;
    checkError = reasonOf(err);
  }
  const current = status?.version ?? null;
  const target = channel === "latest" ? latest : stable;
  return {
    available: true,
    current,
    // 版を名乗れない古い番人(受け口が無い)。更新すれば名乗るようになる。
    legacy: !status,
    // これより前の版へは上げない(canUpdate)。安定版がまだ届いていないときの案内に使う。
    minTarget: PEER_SINCE,
    selfUpdate: status?.selfUpdate ?? null,
    stable,
    latest,
    channel,
    autoUpdate,
    hasUpdate: canUpdate(current, target),
    checkOk,
    checkError,
    last,
  };
}

// ── Cloudflare API ──────────────────────────────────────────────────────────

class CfApiError extends Error {}

async function cf<T>(
  deps: GuardianDeps,
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await deps.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        ...(init.headers ?? {}),
      },
    },
  );
  const data = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ code: number; message: string }>;
  } | null;
  if (!res.ok || !data?.success) {
    const msg =
      data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ||
      `HTTP ${res.status}`;
    throw new CfApiError(`${path.split("/").pop()}: ${msg}`);
  }
  return data.result as T;
}

/** 番人の Worker の名前。app 自身の設定にある WORKEROPS(service binding)の相手。 */
async function guardianName(deps: GuardianDeps, env: Env): Promise<string> {
  const s = await cf<{
    bindings?: Array<{ type?: string; name?: string; service?: string }>;
  }>(deps, env, `/workers/scripts/${env.CF_WORKER_NAME}/settings`);
  const b = (s.bindings ?? []).find(
    (x) => x.name === "WORKEROPS" && x.type === "service",
  );
  if (!b?.service) throw new CfApiError("guardian_name_unknown");
  return b.service;
}

async function activeVersionId(
  deps: GuardianDeps,
  env: Env,
  script: string,
): Promise<string | null> {
  const r = await cf<{
    deployments?: Array<{
      versions?: Array<{ version_id?: string; percentage?: number }>;
    }>;
  }>(deps, env, `/workers/scripts/${script}/deployments`);
  const versions = r.deployments?.[0]?.versions ?? [];
  return (
    (versions.find((v) => v.percentage === 100) ?? versions[0])?.version_id ??
    null
  );
}

/**
 * 番人へ送り直す binding。secret は値を読めないので inherit で引き継ぎ、ほかの型は絞らない
 * (WorkerOps の bindings.ts と同じ。知らない型を落とすと、その版から消える)。
 * 自己更新は切る —— 番人を入れ替えるのはこれから app の役目。
 */
export function guardianBindings(bindings: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const b of bindings ?? []) {
    const t = (b as { type?: string })?.type;
    const name = (b as { name?: string })?.name;
    if (typeof t !== "string" || typeof name !== "string" || !name) continue;
    if (name === "SELF_UPDATE" || name === "APP_TICK") continue;
    if (t === "secret_text" || t === "inherit")
      out.push({ type: "inherit", name });
    else out.push(b);
  }
  out.push({ type: "plain_text", name: "SELF_UPDATE", text: "0" });
  // この app は番人から毎分を受ける(WorkerOps の tick.ts・adoptGuardianMinute)。
  out.push({ type: "plain_text", name: "APP_TICK", text: "1" });
  return out;
}

const MINUTE_KEY = "system:guardian_minute";
/** 同じ isolate で何度も KV を読まない(番人の分は毎分届く)。失敗したら 1 時間あけて試し直す。 */
let minuteAdopted = false;
let minuteRetryAt = 0;

/**
 * 番人から分が届いた(番人が APP_TICK=1 で app を呼べる版になった)ら、cron を番人の 1 本にまとめる
 * (core-offering 11 節・2026-10-22)。無料の Workers は cron がアカウントで 5 本までで、導入 1 件が
 * app の毎分と番人の 2 分ごとの 2 本を使っていた。
 *
 * 顧客導入だけ: app が自分のアカウントの鍵(CF_API_TOKEN)で、番人を毎分にしてから自分の cron を外す
 * (この順 —— 逆だと、間に分が誰からも来ない時間ができる)。委託の app は鍵を持たないので何もしない
 * (委託は cron を持たず、連絡係が番人を呼ぶ。切り替えは導入口がする)。済んだら KV に印を残し、
 * 以後は読まない。
 */
export async function adoptGuardianMinute(
  env: Env,
  deps: GuardianDeps,
): Promise<void> {
  if (minuteAdopted || deps.now() < minuteRetryAt || missingSetup(env)) return;
  if ((await env.PUBLIC_PAGES.get(MINUTE_KEY)) === "1") {
    minuteAdopted = true;
    return;
  }
  const ops = await guardianName(deps, env);
  const put = (script: string, crons: string[]) =>
    cf(deps, env, `/workers/scripts/${script}/schedules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crons.map((cron) => ({ cron }))),
    });
  try {
    await put(ops, ["* * * * *"]);
    await put(env.CF_WORKER_NAME!, []);
  } catch (error) {
    minuteRetryAt = deps.now() + 3600_000;
    throw error;
  }
  await env.PUBLIC_PAGES.put(MINUTE_KEY, "1");
  minuteAdopted = true;
}

async function deploy(
  deps: GuardianDeps,
  env: Env,
  script: string,
  versionId: string,
  message: string,
): Promise<void> {
  await cf(deps, env, `/workers/scripts/${script}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: versionId }],
      annotations: { "workers/message": message.slice(0, 200) },
    }),
  });
}

/** 新しい版が自分の版を名乗るまで待つ。最初の応答で決めない(出した直後は旧版が答える)。 */
async function waitForVersion(
  env: Env,
  deps: GuardianDeps,
  version: string,
): Promise<boolean> {
  const deadline = deps.now() + VERIFY_WINDOW_MS;
  while (deps.now() < deadline) {
    const s = await peerStatus(env);
    if (s?.version && compareVersions(s.version, version) === 0) return true;
    await deps.sleep(VERIFY_INTERVAL_MS);
  }
  return false;
}

/**
 * 番人を、選んだチャンネルの版へ上げる。新しくなければ何もしない(前方のみ)。
 * 結果は KV に残し(画面の 1 行)、up_to_date / busy 以外は Defects へ送る。
 */
export async function guardianUpdate(
  env: Env,
  deps: GuardianDeps,
  trigger: "manual" | "auto",
): Promise<GuardianResult> {
  const at = new Date(deps.now()).toISOString();
  const done = async (
    r: Omit<GuardianResult, "trigger" | "at">,
  ): Promise<GuardianResult> => {
    const result: GuardianResult = { ...r, trigger, at };
    if (r.outcome !== "up_to_date" && r.outcome !== "busy") {
      await env.PUBLIC_PAGES.put(LAST_KEY, JSON.stringify(result));
    }
    return result;
  };

  const missing = missingSetup(env);
  if (missing)
    return done({
      outcome: "unavailable",
      from: null,
      to: null,
      error: missing,
    });

  const status = await peerStatus(env);
  const from = status?.version ?? null;
  let to: string | null = null;
  try {
    const channel = await getGuardianChannel(env);
    to = await deps.channelVersion(updateChannelOf(channel));
    if (!canUpdate(from, to))
      return done({ outcome: "up_to_date", from, to, error: null });
  } catch (err) {
    await deps.report("guardian_update_failed", {
      from: from ?? "-",
      to: to ?? "-",
      reason: reasonOf(err),
    });
    return done({ outcome: "failed", from, to, error: reasonOf(err) });
  }

  // 番人の鍵。名乗れる番人なら hold() もある。断られたら(app を更新中・確かめ中)次に回す。
  let held = false;
  if (status) {
    try {
      const h = await env.WORKEROPS!.hold!(HOLD_MS);
      if (!h?.ok)
        return done({ outcome: "busy", from, to, error: h?.reason ?? "busy" });
      held = true;
    } catch (err) {
      return done({
        outcome: "failed",
        from,
        to,
        error:
          `hold: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200,
          ),
      });
    }
  }

  let script = "";
  let previous: string | null = null;
  let deployed = false;
  try {
    const { mainModule, code } = await deps.fetchCode(to);
    script = await guardianName(deps, env);
    previous = await activeVersionId(deps, env, script);
    const settings = await cf<{
      bindings?: unknown[];
      compatibility_date?: string;
      compatibility_flags?: string[];
    }>(deps, env, `/workers/scripts/${script}/settings`);
    const form = new FormData();
    form.append(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: mainModule,
            bindings: guardianBindings(settings.bindings ?? []),
            compatibility_date: settings.compatibility_date ?? "2024-11-01",
            compatibility_flags: settings.compatibility_flags ?? [],
          }),
        ],
        { type: "application/json" },
      ),
      "metadata.json",
    );
    form.append(
      mainModule,
      new File([code], mainModule, { type: "application/javascript+module" }),
    );
    const version = await cf<{ id: string }>(
      deps,
      env,
      `/workers/scripts/${script}/versions`,
      { method: "POST", body: form },
    );
    await deploy(
      deps,
      env,
      script,
      version.id,
      `KuroCMS ${deps.appVersion}: WorkerOps ${from ?? "?"} → ${to}`,
    );
    deployed = true;

    if (await waitForVersion(env, deps, to)) {
      await deps.report("guardian_update_ok", { from: from ?? "-", to });
      return await done({ outcome: "updated", from, to, error: null });
    }
    throw new CfApiError("verify_timeout");
  } catch (err) {
    const reason =
      err instanceof CfApiError ? err.message.slice(0, 200) : reasonOf(err);
    if (!deployed || !previous) {
      await deps.report("guardian_update_failed", {
        from: from ?? "-",
        to: to ?? "-",
        reason,
      });
      return await done({ outcome: "failed", from, to, error: reason });
    }
    try {
      await deploy(
        deps,
        env,
        script,
        previous,
        `KuroCMS ${deps.appVersion}: WorkerOps ${to} did not answer — back to the previous version`,
      );
      await deps.report("guardian_update_rolled_back", {
        from: from ?? "-",
        to,
        reason,
      });
      return await done({ outcome: "rolled_back", from, to, error: reason });
    } catch (back) {
      const why =
        back instanceof CfApiError
          ? back.message.slice(0, 200)
          : reasonOf(back);
      await deps.report("guardian_rollback_failed", {
        from: from ?? "-",
        to,
        reason: `${reason} / ${why}`,
      });
      return await done({
        outcome: "failed",
        from,
        to,
        error: `rollback_failed: ${why}`,
      });
    }
  } finally {
    if (held) {
      try {
        await env.WORKEROPS!.release!();
      } catch {
        /* 鍵は TTL で必ず切れる */
      }
    }
  }
}

/**
 * 毎分の cron から呼ぶ。自動更新が入で、app の版が変わったのを見つけたら番人を上げる。
 * 書き込みは版が変わった最初の 1 回と、済んだときの 1 回だけ(KV の書き込み枠を焼かない)。
 */
export async function guardianAutoTick(
  env: Env,
  deps: GuardianDeps,
): Promise<GuardianResult | null> {
  if (missingSetup(env)) return null;
  if (!(await getGuardianAuto(env))) return null;
  let seen: { app?: string; at?: number; done?: boolean } = {};
  try {
    seen = JSON.parse((await env.PUBLIC_PAGES.get(SEEN_KEY)) ?? "{}");
  } catch {
    /* 読めなければ、版が変わったものとして扱う */
  }
  if (seen.app === deps.appVersion && seen.done) return null;
  if (seen.app !== deps.appVersion) {
    seen = { app: deps.appVersion, at: deps.now(), done: false };
    await env.PUBLIC_PAGES.put(SEEN_KEY, JSON.stringify(seen));
  }
  // 古い番人は hold() で「app の確かめ中か」を聞けないので、確かめが終わる時間を待つ。
  if (!(await peerStatus(env)) && deps.now() - (seen.at ?? 0) < LEGACY_WAIT_MS)
    return null;
  const r = await guardianUpdate(env, deps, "auto");
  if (r.outcome === "busy") return r; // 次の分にやり直す
  await env.PUBLIC_PAGES.put(SEEN_KEY, JSON.stringify({ ...seen, done: true }));
  return r;
}
