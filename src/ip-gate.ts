/**
 * 管理画面の接続元の登録（IP 制限・cms-cms-security「IP 制限」・2026-10-17）。
 *
 * **登録は全自動で、利用者は存在を知るだけ**（運用者の決定）。
 *   - パスキーでログインしたら、その回線を登録する（新しい回線なら、本人へメールで知らせる）
 *   - 使うたびに期限を延ばす（1 時間に 1 回まで書く）
 *   - 登録の無い回線からログイン済みのクッキーが使われたら止め、確認のリンクを本人へ自動でメールする。
 *     リンクを**申請した回線から**押したときだけ登録する（パスキーで入り直しても登録される）
 *   - 登録が 1 つも無い人（入れた直後・更新の直後）は、次の要求の回線をそのまま登録する
 *     —— 更新で誰も締め出さない
 *
 * 照合・登録・設定の整え方は entamy-connect の ip-gate.ts（Admin と同じ処理）。ここに置くのは、
 * 主体（KuroCMS の利用者）の決め方・設定の置き場（KV）・メールの文面・確認のリンクだけ。
 *
 * 盗まれたクッキーは、登録していない回線では使えない。止めたことは本人へのメールで分かる。
 */
import * as gate from "./vendor/entamy-client/index.ts";
import type { Network } from "./vendor/entamy-client/index.ts";
import { HttpError } from "./http.ts";
import type { AuthUser, Env } from "./types.ts";

export type IpGateConfig = gate.IpGateConfig;

/** 設定の置き場（KV）。 */
export const IP_GATE_KEY = "system:ip_gate";

/**
 * KuroCMS の既定。**既定で入**（登録が全自動なので、入れても誰の手間も増えない）。
 * 期限は Admin（7 日・1 日）より長い —— KuroCMS のログインは 30 日続き、数日ぶりに開いた人を
 * 毎回メールの確認に回さないため。PAT は既定で縛らない —— AI のエージェントや MCP は
 * クラウドの毎回変わる回線から来る。どちらも設定の「IP 制限」で変えられる。
 */
export const DEFAULT_IP_GATE: IpGateConfig = {
  enabled: true,
  ipv6: true,
  ipv4: true,
  ttl_v6_days: 30,
  ttl_v4_days: 7,
  pat: false,
  trial_until: null,
};

/** 同じ回線への確認のメールは、この間に 1 通まで。 */
export const CONFIRM_THROTTLE_MS = 10 * 60 * 1000;

export interface IpGateDeps {
  now: () => number;
  /** メールを 1 通送る（api.ts の sendMail。失敗は投げる）。 */
  sendMail: (
    env: Env,
    msg: { to: string; subject: string; text: string; html: string },
  ) => Promise<unknown>;
}

const defaultDeps: IpGateDeps = {
  now: () => Date.now(),
  // api.ts は auth.ts を読み、auth.ts はここを読む。読み込みの輪を作らないよう、使うときに読む。
  sendMail: async (env, msg) => (await import("./api.ts")).sendMail(env, msg),
};

export const ipStore = (env: Env): gate.IpGateStore => ({
  db: env.DB as unknown as gate.IpGateDb,
  table: "ip_allow",
  scope: "admin",
});

export async function readIpGateConfig(env: Env): Promise<IpGateConfig> {
  const raw = await env.PUBLIC_PAGES.get(IP_GATE_KEY);
  if (!raw) return { ...DEFAULT_IP_GATE };
  try {
    return gate.normalizeIpGateConfig(
      JSON.parse(raw) as Partial<IpGateConfig>,
      DEFAULT_IP_GATE,
    );
  } catch {
    return { ...DEFAULT_IP_GATE };
  }
}

export async function writeIpGateConfig(
  env: Env,
  value: unknown,
): Promise<IpGateConfig> {
  const cfg = gate.normalizeIpGateConfig(
    (value ?? {}) as Partial<IpGateConfig>,
    DEFAULT_IP_GATE,
  );
  // 両方を切ると、誰も入れない。
  if (!cfg.ipv4 && !cfg.ipv6)
    throw new HttpError(
      400,
      "ip_gate_no_family",
      "Allow IPv4 or IPv6 (or both).",
    );
  await env.PUBLIC_PAGES.put(IP_GATE_KEY, JSON.stringify(cfg));
  return cfg;
}

/** 管理画面の道の頭（"/kurocms/admin" → "/kurocms"）。確認のリンクを API へ向ける。 */
function basePath(env: Env): string {
  const raw = String(env.ACCESS_ADMIN_URL || "/kurocms/admin").trim();
  let p: string;
  try {
    p = new URL(raw).pathname;
  } catch {
    p = raw.startsWith("/") ? raw : `/${raw}`;
  }
  p = p.replace(/\/+$/, "");
  return p.endsWith("/admin") ? p.slice(0, -"/admin".length) : p;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

async function siteName(env: Env): Promise<string> {
  const r = await env.DB.prepare(
    "SELECT site_name FROM site_settings WHERE id = 1",
  ).first<{ site_name: string | null }>();
  return (r?.site_name ?? "KuroCMS").trim() || "KuroCMS";
}

async function sha256Hex(text: string): Promise<string> {
  const b = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * ログイン済みの要求の回線を確かめる。**tryAuth から呼ぶ**（すべての管理の口が通る）。
 * 止めるときは 403 network_unregistered を投げ、確認のリンクを本人へメールする（10 分に 1 通まで）。
 */
export async function enforceNetwork(
  env: Env,
  request: Request,
  user: AuthUser,
  deps: IpGateDeps = defaultDeps,
): Promise<void> {
  const cfg = await readIpGateConfig(env);
  if (!cfg.enabled) return;
  if (user.authSource === "pat" && !cfg.pat) return;
  const conn = gate.requestNetwork(request);
  // Cloudflare の縁を通らない要求（手元の開発）には接続元が無い。縁を通る要求には必ずある。
  if (!conn) return;
  const store = ipStore(env);
  const now = deps.now();
  if (await gate.subjectAllowed(store, cfg, user.uid, conn, now)) return;
  if (!gate.familyAllowed(cfg, conn.family)) {
    throw new HttpError(
      403,
      "network_family_not_allowed",
      `Connections over ${conn.family === "v6" ? "IPv6" : "IPv4"} are not allowed.`,
    );
  }
  // 登録が 1 つも無い人（入れた直後・更新の直後）は、この回線をそのまま登録する。
  if ((await gate.connectionCount(store, user.uid, now)) === 0) {
    await gate.registerConnection(
      store,
      cfg,
      user.uid,
      conn,
      gate.lineDescription(request),
      now,
    );
    return;
  }
  try {
    await sendConfirmation(env, request, user, conn, now, deps);
  } catch {
    /* 送れなくても止めることは変えない。パスキーで入り直せば登録される */
  }
  throw new HttpError(
    403,
    "network_unregistered",
    "This network is not registered for your account. We emailed you a confirmation link; signing in again with your passkey also registers it.",
  );
}

/** パスキーでログインした回線を登録する。新しい回線なら本人へ知らせる（初めての回線は知らせない）。 */
export async function registerLoginNetwork(
  env: Env,
  request: Request,
  uid: string,
  email: string,
  deps: IpGateDeps = defaultDeps,
): Promise<void> {
  const cfg = await readIpGateConfig(env);
  if (!cfg.enabled) return;
  const conn = gate.requestNetwork(request);
  if (!conn || !gate.familyAllowed(cfg, conn.family)) return;
  const store = ipStore(env);
  const now = deps.now();
  const had = (await gate.connectionCount(store, uid, now)) > 0;
  const label = gate.lineDescription(request);
  const added = await gate.registerConnection(
    store,
    cfg,
    uid,
    conn,
    label,
    now,
  );
  if (!added || !had || !email) return;
  try {
    const site = await siteName(env);
    const shown = gate.shownNet(conn.net, label);
    await deps.sendMail(env, {
      to: email,
      subject: `[${site}] 新しい回線を登録しました / New network registered`,
      text:
        `${site} の管理画面に、新しい回線からパスキーでログインしたので、その回線を登録しました。\n回線: ${shown}\n` +
        `心当たりがなければ、管理画面のプロフィールの「登録した回線」から外し、パスキーを見直してください。\n\n` +
        `You signed in to ${site} with your passkey from a new network, so it was registered.\nNetwork: ${shown}\n` +
        `If this wasn't you, remove it under Profile → Registered networks and review your passkeys.\n`,
      html:
        `<p>${esc(site)} の管理画面に、新しい回線からパスキーでログインしたので、その回線を登録しました。</p>` +
        `<p>回線: <code>${esc(shown)}</code></p>` +
        `<p style="color:#666;font-size:13px">心当たりがなければ、管理画面のプロフィールの「登録した回線」から外し、パスキーを見直してください。</p><hr>` +
        `<p>You signed in to ${esc(site)} with your passkey from a new network, so it was registered.</p>` +
        `<p>Network: <code>${esc(shown)}</code></p>` +
        `<p style="color:#666;font-size:13px">If this wasn't you, remove it under Profile → Registered networks and review your passkeys.</p>`,
    });
  } catch {
    /* 知らせが届かなくても、登録は済んでいる */
  }
}

/** パスキーでログインしてから、もう片方の族を一緒に登録できる間。 */
export const SIBLING_WINDOW_MS = 2 * 60 * 1000;

/**
 * パスキーでログインした直後に、**もう片方の族（IPv4 ⇔ IPv6）の回線も登録する**。
 *
 * IPv4 と IPv6 は別の回線として登録され、ログインで登録されるのはその要求が通った族だけ。
 * ブラウザは後で勝手にもう片方へ切り替える（Happy Eyeballs）ので、同じ家の回線でも止まり、
 * パスキーを求め直していた（2026-10-19 の調べ・cms-cms-security）。画面は、Cloudflare の
 * 1.1.1.1 の族ごとの宛先（`https://1.1.1.1/cdn-cgi/trace`・`https://[2606:4700:4700::1111]/cdn-cgi/trace`）
 * から自分のアドレスを読み、ここへ送る。workers.dev は族ごとの宛先を持たないため。
 *
 * 送られたアドレスはサーバーが見たものではないので、受けるのは次をすべて満たすときだけ。
 *   - この要求そのものが回線の照合を通っている（tryAuth の enforceNetwork）—— 盗まれたクッキーは
 *     登録の無い回線から来るので、ここまで届かない
 *   - パスキーで作ったセッションで、作ってから SIBLING_WINDOW_MS 以内
 *   - この要求と違う族のアドレス（同じ族は、この要求が通った時点で登録済み）
 * 足すのは自動の行（期限つき）。登録できたら回線を返す。
 */
export async function registerSiblingNetwork(
  env: Env,
  request: Request,
  user: AuthUser,
  ips: unknown,
  deps: Pick<IpGateDeps, "now"> = defaultDeps,
): Promise<{ net: string } | null> {
  const cfg = await readIpGateConfig(env);
  if (!cfg.enabled) return null;
  const conn = gate.requestNetwork(request);
  if (!conn || !user.sessionId) return null;
  const now = deps.now();
  const session = await env.DB.prepare(
    "SELECT created_at, credential_id FROM sessions WHERE session_id = ? AND uid = ?",
  )
    .bind(user.sessionId, user.uid)
    .first<{ created_at: string; credential_id: string | null }>();
  if (
    !session?.credential_id ||
    !(Date.parse(session.created_at) > now - SIBLING_WINDOW_MS)
  )
    throw new HttpError(
      403,
      "sibling_window_closed",
      "The other network can only be registered right after signing in with a passkey.",
    );
  for (const raw of Array.isArray(ips) ? ips.slice(0, 2) : []) {
    if (typeof raw !== "string" || raw.includes("/")) continue;
    let parsed: { family: "v4" | "v6"; net: string };
    try {
      parsed = gate.parseManualNet(raw);
    } catch {
      continue;
    }
    if (
      parsed.family === conn.family ||
      !gate.familyAllowed(cfg, parsed.family)
    )
      continue;
    const sibling: Network = { ...parsed, ip: raw.trim().toLowerCase() };
    await gate.registerConnection(
      ipStore(env),
      cfg,
      user.uid,
      sibling,
      gate.lineDescription(request),
      now,
    );
    return { net: sibling.net };
  }
  return null;
}

async function sendConfirmation(
  env: Env,
  request: Request,
  user: AuthUser,
  conn: Network,
  now: number,
  deps: IpGateDeps,
): Promise<void> {
  if (!user.email) return;
  const recent = await env.DB.prepare(
    "SELECT 1 AS x FROM ip_confirmations WHERE subject = ? AND net = ? AND requested_at > ? LIMIT 1",
  )
    .bind(user.uid, conn.net, now - CONFIRM_THROTTLE_MS)
    .first();
  if (recent) return;
  const token = newToken();
  const label = gate.lineDescription(request);
  await env.DB.prepare(
    `INSERT INTO ip_confirmations (token_hash, subject, net, family, ip, label, requested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      user.uid,
      conn.net,
      conn.family,
      conn.ip,
      label,
      now,
      now + gate.IP_GATE_REQUEST_TTL_MS,
    )
    .run();
  const link = `${new URL(request.url).origin}${basePath(env)}/api/auth/network/confirm?t=${encodeURIComponent(token)}`;
  const site = await siteName(env);
  const shown = gate.shownNet(conn.net, label);
  const minutes = Math.round(gate.IP_GATE_REQUEST_TTL_MS / 60000);
  await deps.sendMail(env, {
    to: user.email,
    subject: `[${site}] 新しい回線の確認 / Confirm a new network`,
    text:
      `${site} の管理画面が、登録していない回線から使われようとしたので止めました。\n回線: ${shown}\n` +
      `あなたなら、その回線（同じ端末・同じネットワーク）で次のリンクを開き、ボタンを押してください（${minutes} 分間有効）:\n${link}\n` +
      `パスキーでログインし直しても登録されます。心当たりがなければ、何もしないでください（登録されません）。\n\n` +
      `${site}'s admin was used from a network that isn't registered, so it was blocked.\nNetwork: ${shown}\n` +
      `If it was you, open this link on that network (same device, same connection) and press the button (valid for ${minutes} minutes):\n${link}\n` +
      `Signing in again with your passkey also registers it. If it wasn't you, do nothing — it won't be registered.\n`,
    html:
      `<p>${esc(site)} の管理画面が、登録していない回線から使われようとしたので止めました。</p>` +
      `<p>回線: <code>${esc(shown)}</code></p>` +
      `<p>あなたなら、その回線（同じ端末・同じネットワーク）で次のリンクを開き、ボタンを押してください（${minutes} 分間有効）。</p>` +
      `<p><a href="${esc(link)}">この回線を登録する</a></p>` +
      `<p style="color:#666;font-size:13px">パスキーでログインし直しても登録されます。心当たりがなければ、何もしないでください（登録されません）。</p><hr>` +
      `<p>${esc(site)}'s admin was used from a network that isn't registered, so it was blocked.</p>` +
      `<p>Network: <code>${esc(shown)}</code></p>` +
      `<p>If it was you, open this link on that network (same device, same connection) and press the button (valid for ${minutes} minutes).</p>` +
      `<p><a href="${esc(link)}">Register this network</a></p>` +
      `<p style="color:#666;font-size:13px">Signing in again with your passkey also registers it. If it wasn't you, do nothing — it won't be registered.</p>`,
  });
}

function page(title: string, body: string, status = 200): Response {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.7;color:#1b2533}` +
    `button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#0f766e;color:#fff;cursor:pointer}code{background:#f1f5f9;padding:1px 4px;border-radius:4px}</style>` +
    `</head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

async function openConfirmation(env: Env, token: string, now: number) {
  if (!token || token.length > 200) return null;
  return env.DB.prepare(
    "SELECT token_hash, subject, net, family, label FROM ip_confirmations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(token), now)
    .first<{
      token_hash: string;
      subject: string;
      net: string;
      family: "v4" | "v6";
      label: string;
    }>();
}

/**
 * 確認のリンク。GET は頁を出すだけで何も変えない（メールの検査器が先に開いても使い切らない）。
 * POST で、**申請した回線から押したときだけ**登録する。
 */
export async function handleNetworkConfirm(
  request: Request,
  env: Env,
  deps: IpGateDeps = defaultDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const now = deps.now();
  const token =
    request.method === "POST"
      ? String(new URLSearchParams(await request.text()).get("t") ?? "")
      : String(url.searchParams.get("t") ?? "");
  const req = await openConfirmation(env, token, now);
  if (!req) {
    return page(
      "リンクが無効です / Invalid link",
      "<h1>リンクが無効です</h1><p>期限が切れたか、使い終わったリンクです。パスキーでログインし直すと、その回線が登録されます。</p>" +
        "<hr><p>This link has expired or was already used. Signing in again with your passkey registers your network.</p>",
      410,
    );
  }
  const shown = esc(gate.shownNet(req.net, req.label));
  if (request.method !== "POST") {
    return page(
      "回線の登録 / Register network",
      `<h1>この回線を登録しますか？</h1><p>回線: <code>${shown}</code></p>` +
        `<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">登録する / Register</button></form>` +
        `<p style="color:#666;font-size:13px">メールを受け取った回線（同じ端末・同じネットワーク）で押してください。違う回線からは登録できません。</p>` +
        `<hr><p>Press the button on the network that received this email (same device, same connection). It can't be registered from a different network.</p>`,
    );
  }
  const conn = gate.requestNetwork(request);
  if (!conn || conn.net !== req.net) {
    return page(
      "回線が違います / Different network",
      `<h1>回線が違います</h1><p>このリンクは <code>${shown}</code> から押したときだけ登録できます。メールを受け取った回線で開き直すか、パスキーでログインし直してください。</p>` +
        `<hr><p>This link only works from <code>${shown}</code>. Open it on that network, or sign in again with your passkey.</p>`,
      403,
    );
  }
  const used = await env.DB.prepare(
    "UPDATE ip_confirmations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
  )
    .bind(now, req.token_hash)
    .run();
  if (!(used.meta?.changes ?? 0))
    return page(
      "使用済み / Already used",
      "<h1>このリンクは使用済みです</h1><hr><p>This link was already used.</p>",
      410,
    );
  const cfg = await readIpGateConfig(env);
  await gate.registerConnection(
    ipStore(env),
    cfg,
    req.subject,
    conn,
    gate.lineDescription(request),
    now,
  );
  return page(
    "登録しました / Registered",
    `<h1>回線を登録しました</h1><p><code>${shown}</code></p><p>管理画面を開き直してください。</p>` +
      `<hr><p>Your network was registered. Reopen the admin panel.</p>`,
  );
}

/**
 * 自分の登録した回線の一覧（プロフィールの「登録した回線」・設定の「登録 IPv6」）。
 * pinned は手で足した固定の行（期限なし）。
 */
export async function listMyNetworks(env: Env, uid: string, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT id, net, family, label, note, pinned, created_at, last_seen_at, expires_at FROM ip_allow WHERE scope = 'admin' AND subject = ? AND expires_at > ? ORDER BY pinned DESC, last_seen_at DESC",
  )
    .bind(uid, now)
    .all<{
      id: string;
      net: string;
      family: string;
      label: string;
      note: string | null;
      pinned: number;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
    }>();
  return (results ?? []).map((r) => ({ ...r, pinned: r.pinned === 1 }));
}

/**
 * 自分の IPv6 の回線を手で足す（設定の「IP 制限」→「登録 IPv6」）。**固定（期限なし）**。
 *
 * 自動の登録は /64 なので、プロバイダーが /64 を配り直すと、同じ家の回線でも別の回線として
 * 止まる。/48・/56 のように、プロバイダーから受けている prefix を固定で持てば、その中の /64 が
 * 変わっても通る。照合は entamy-connect の candidateNets（/32〜/64）がそのまま拾う。
 * IPv4 は受けない —— 家庭の IPv4 はプロバイダーの共有の出口で、固定すると他人まで通す。
 */
export async function addMyNetwork(
  env: Env,
  uid: string,
  raw: unknown,
  noteRaw: unknown,
  now = Date.now(),
): Promise<{ id: string; net: string }> {
  let parsed: { family: "v4" | "v6"; net: string };
  try {
    parsed = gate.parseManualNet(typeof raw === "string" ? raw : "");
  } catch (e) {
    if (e instanceof gate.NetInputError)
      throw new HttpError(400, "invalid_network", e.message);
    throw e;
  }
  if (parsed.family !== "v6")
    throw new HttpError(
      400,
      "ipv6_only",
      "Only IPv6 prefixes can be added (e.g. 2400:4050:7e40::/48).",
    );
  const note =
    typeof noteRaw === "string" ? noteRaw.trim().slice(0, 100) || null : null;
  const pinnedCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM ip_allow WHERE scope = 'admin' AND subject = ? AND pinned = 1",
  )
    .bind(uid)
    .first<{ n: number }>();
  if ((pinnedCount?.n ?? 0) >= gate.IP_GATE_MAX_PER_SUBJECT)
    throw new HttpError(
      400,
      "too_many_networks",
      `Up to ${gate.IP_GATE_MAX_PER_SUBJECT} fixed networks can be added.`,
    );
  const id = crypto.randomUUID();
  // 自動で入っていた同じ prefix の行は、固定に格上げする（行は 1 つのまま）。
  await env.DB.prepare(
    `INSERT INTO ip_allow (id, scope, subject, net, family, label, note, pinned, added_by, created_at, last_seen_at, expires_at)
     VALUES (?1, 'admin', ?2, ?3, 'v6', '', ?4, 1, ?2, ?5, ?5, ?6)
     ON CONFLICT(scope, subject, net) DO UPDATE
       SET pinned = 1, added_by = excluded.added_by, note = excluded.note, expires_at = excluded.expires_at`,
  )
    .bind(id, uid, parsed.net, note, now, gate.IP_GATE_PINNED_UNTIL)
    .run();
  return { id, net: parsed.net };
}

/** 自分の回線を外す。 */
export async function removeMyNetwork(
  env: Env,
  uid: string,
  id: string,
): Promise<boolean> {
  const r = await env.DB.prepare(
    "DELETE FROM ip_allow WHERE scope = 'admin' AND subject = ? AND id = ?",
  )
    .bind(uid, id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** 期限の切れた回線と確認を消す（定期処理から）。 */
export async function purgeIpGate(env: Env, now = Date.now()): Promise<void> {
  await gate.purgeExpiredConnections(ipStore(env), now);
  await env.DB.prepare("DELETE FROM ip_confirmations WHERE expires_at <= ?")
    .bind(now)
    .run();
}

/** いまの要求の回線（設定の画面に「この回線」として出す）。 */
export function currentNetwork(
  request: Request,
): { net: string; label: string } | null {
  const conn = gate.requestNetwork(request);
  return conn ? { net: conn.net, label: gate.lineDescription(request) } : null;
}
