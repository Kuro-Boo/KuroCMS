/**
 * 公開ページを Workers Static Assets に置く(cms-cms-build「公開ページを
 * Workers Static Assets に置く」・cms-workerops)。
 *
 * ## 流れ
 *
 * - KV にページを書く 1 か所(public.ts の kvPutBundle)が、各言語の版の
 *   ハッシュと大きさを `asset_pages` に書く(`recordPages`)。消す所は消す。
 * - **ビルドを明示して、それが終わったとき**(全体ビルドの最後の回・記事 1 件の
 *   ビルド・予定公開の自動ビルド)に一覧を番人へ渡す(`publishAssets`)。番人が
 *   足りないファイルだけを `read` で聞き返し、今のコード + 新しい資産で版を出す。
 *   app は自分で版を出さない。
 * - 公開ページを変えるのはビルドだけ、という仕様に合わせる(運用者の決定
 *   2026-10-16)。保存のときなどに KV が作り直されても、資産は次のビルドまで変えない。
 * - 一覧は渡す時点の KV の中身(`asset_pages`)から作る。
 *
 * ## 渡せなければ、ビルドは終わらない
 *
 * 登録はビルドの一部。番人が別の操作で鍵を持っている・1 回で読み切れなかった
 * ときは、ビルドの最後の回を「続きあり」(more)で返し、次の回がそのまま登録を
 * やり直す(ビルドは終わるまで回を続ける作り)。時間で待つ仕掛けは持たない。
 * 予定公開の自動ビルドも、登録の済んでいないビルドを「まだ終わっていない」と見る
 * (`assetsPending`)。
 *
 * ## 1 回で読むページの数に上限
 *
 * 番人が聞き返したページは、この呼び出しの中で KV から読む。1 回の実行で使える
 * 読み出しの数には上限があり、ビルドの直後はもう大半を使っている。だから 1 回に
 * 読むページ数を絞る(`maxReads`)。読み切れなければ番人はその回を失敗にするが、
 * 上げ終わったファイルは Cloudflare が覚えていて次の回では聞かれない —— 初めての
 * 大きなサイトも、ビルドの回を重ねて上がり切る。
 *
 * ⚠ ここは cloudflare:workers を読まない(node で直接試験する)。
 */
import type { Env } from "./types";
import { langPath } from "./lang-path.ts";

/**
 * UTF-8 の文字列 → base64(資産の上げ口は base64 で受ける)。
 *
 * 組み込みの Uint8Array.prototype.toBase64 を使う。String.fromCharCode で 1 字ずつ作る形は、
 * 11 言語のページ 1 つ(約 870 KB)で 12 ms かかり、登録の CPU の 9 割を占めていた。1 回に
 * 100 ページを読む最後の回が CPU の上限で打ち切られ、全体ビルドが終わらなかった
 * (課題 a408a584・2026-10-21 に dump の写しで測った。組み込みは同じ出力で 0.85 ms)。
 * 組み込みの無い所(古い実行環境)だけ前の形で作る。
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * 資産のハッシュ(32 桁の 16 進)= 中身の UTF-8 のバイト列の SHA-256 の先頭 32 桁。
 *
 * Cloudflare の文書の例は SHA-256(base64 + 拡張子) だが、Cloudflare は一致を
 * 見るだけで作り方を確かめない(バイト列の SHA-256 で上げて配られることを
 * 2026-10-16 に試験用 Worker で確認。wrangler 自身も BLAKE3 を使う)。
 * base64 を作らずに済むので、ページを書くたび(ビルドの CPU)が軽い。
 */
export async function assetHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** ページのパス(KV のキーと同じ、末尾 / なし)と言語 → 資産のファイルのパス。 */
export function pageAssetPath(
  path: string,
  lang: string,
  defaultLang: string,
  publicBase: string,
): string {
  const dir =
    path === "/" || path === "" ? "/" : `${path.replace(/\/+$/, "")}/`;
  return `${publicBase}${langPath(dir, lang, defaultLang)}index.html`;
}

/** KV に書いたページの各言語の版を索引に残す。表がまだ無い(移行前)ときは何もしない。 */
export async function recordPages(
  env: Env,
  path: string,
  bundle: Record<string, string>,
): Promise<void> {
  await env.DB.batch(await pageRecordStatements(env, path, bundle)).catch(
    () => {},
  );
}

/**
 * recordPages の文だけを作る(実行しない)。全体ビルドは、もともとページごとに
 * 1 往復あるビルドの記録(page_build_cache)と同じ batch で送る —— D1 への往復は
 * 1 回ごとに D1 のある地域まで行くので、別の往復にすると全ページにその待ちが乗る
 * (2026-10-16 に測った: 1 ページあたり 100〜150ms 遅くなっていた)。
 */
/**
 * 頁の HTML が参照するメディアの R2 のキー(`images/img-163.jpg` など・課題 d9968d85)。公開の頁が参照する
 * メディアだけを配るために、頁を書くたびに記録する。src・srcset・data 属性・CSS の url() のどれでも拾う。
 */
export function mediaKeysOf(html: string): string[] {
  const keys = new Set<string>();
  for (const m of html.matchAll(
    /(?:^|[^A-Za-z0-9_-])(images|videos|audios)\/([A-Za-z0-9._-]{1,200})/g,
  ))
    keys.add(`${m[1]}/${m[2]}`);
  return [...keys];
}

export async function pageRecordStatements(
  env: Env,
  path: string,
  bundle: Record<string, string>,
): Promise<D1PreparedStatement[]> {
  const now = new Date().toISOString();
  const langs = Object.keys(bundle);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `DELETE FROM asset_pages WHERE path = ? AND lang NOT IN (${langs.map(() => "?").join(",") || "''"})`,
    ).bind(path, ...langs),
  ];
  // 頁が参照するメディア(公開の頁が参照するものだけを配る・課題 d9968d85)。言語の版を合わせて 1 組。
  const media = new Set<string>();
  for (const lang of langs)
    for (const k of mediaKeysOf(bundle[lang]!)) media.add(k);
  stmts.push(
    env.DB.prepare("DELETE FROM page_media WHERE path = ?").bind(path),
  );
  for (const k of media)
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO page_media (path, media_key) VALUES (?, ?)",
      ).bind(path, k),
    );
  stmts.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO page_media_scan (path) VALUES (?)",
    ).bind(path),
  );
  for (const lang of langs) {
    const html = bundle[lang]!;
    const hash = await assetHash(html);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO asset_pages (path, lang, hash, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, lang) DO UPDATE SET hash = excluded.hash, size = excluded.size, updated_at = excluded.updated_at`,
      ).bind(path, lang, hash, new TextEncoder().encode(html).length, now),
    );
  }
  return stmts;
}

/** ページを消したとき(パスを渡す)・全部消したとき(null)。 */
export async function forgetPages(
  env: Env,
  paths: string[] | null,
): Promise<void> {
  if (paths === null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM asset_pages"),
      env.DB.prepare("DELETE FROM page_media"),
      env.DB.prepare("DELETE FROM page_media_scan"),
    ]).catch(() => {});
    return;
  }
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM asset_pages WHERE path IN (${marks})`).bind(
        ...chunk,
      ),
      env.DB.prepare(`DELETE FROM page_media WHERE path IN (${marks})`).bind(
        ...chunk,
      ),
      env.DB.prepare(
        `DELETE FROM page_media_scan WHERE path IN (${marks})`,
      ).bind(...chunk),
    ]).catch(() => {});
  }
}

/**
 * 全体ビルドが読むビルドの記録(page_build_cache)。メディアを記録し終えていない頁の記録は読まない
 * (作り直して、参照するメディアを記録する・課題 d9968d85)。表がまだ無い(移行前)ときは全部読む。
 * ⚠ ビルドの記録のパスは末尾 / あり(`/blog/`)、page_media_scan は末尾 / なし(`/blog`)。
 *   そろえずに比べると `/` 以外のどの頁も読まれず、全体ビルドは回のたびに頭から作り直し、
 *   1 回で終わらないサイトは最後まで進まなかった(2026-10-26)。
 */
export async function loadRecordedBuildCache(
  env: Env,
): Promise<{ path: string; lang: string; source_hash: string }[]> {
  type Row = { path: string; lang: string; source_hash: string };
  const rows = await env.DB.prepare(
    `SELECT c.path, c.lang, c.source_hash FROM page_build_cache c
      WHERE EXISTS (SELECT 1 FROM page_media_scan s WHERE s.path =
        CASE WHEN c.path <> '/' AND c.path LIKE '%/'
             THEN substr(c.path, 1, length(c.path) - 1) ELSE c.path END)`,
  )
    .all<Row>()
    .catch(() =>
      env.DB.prepare(
        `SELECT path, lang, source_hash FROM page_build_cache`,
      ).all<Row>(),
    );
  return rows.results ?? [];
}

/**
 * 公開の頁がすべてメディアを記録し終えたら、公開の前のメディアを配らない形に切り替える
 * (全体ビルドの最後まで済んだ回が呼ぶ)。記録の無い頁が残っていれば切り替えない。
 */
export async function markMediaGateReady(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO page_media_state (id, ready)
       SELECT 1, 1 WHERE NOT EXISTS (
         SELECT 1 FROM asset_pages a WHERE NOT EXISTS (SELECT 1 FROM page_media_scan s WHERE s.path = a.path))
     ON CONFLICT(id) DO UPDATE SET ready = 1`,
  )
    .run()
    .catch(() => {});
}

/**
 * このメディアを誰にでも配ってよいか。切り替えの前(記録の無い頁が残る間)は前のとおり配る。
 * 切り替えた後は、公開の頁が参照するものだけ。表の無い前の版の D1 では配る。
 */
export async function mediaIsPublic(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT ready FROM page_media_state WHERE id = 1), 0) AS ready,
            EXISTS(SELECT 1 FROM page_media WHERE media_key = ?) AS pub`,
  )
    .bind(key)
    .first<{ ready: number; pub: number }>()
    .catch(() => null);
  if (!row) return true;
  return row.ready !== 1 || row.pub === 1;
}

export interface ManifestFile {
  hash: string;
  size: number;
  type: string;
}

/** 一覧と、ハッシュ → 中身の引き方。 */
export interface Manifest {
  files: Record<string, ManifestFile>;
  /** HTML 以外(テンプレートの CSS)の中身。ページは KV から読む。 */
  inline: Map<string, string>;
  /** ハッシュ → (パス, 言語)。ページの中身を KV から読み直すため。 */
  pages: Map<string, { path: string; lang: string }>;
}

/**
 * 一覧を作る。サイトが非公開なら空(番人は資産を全部外す)。
 * `readSite` は公開に要る設定とテンプレートの CSS を返す(public.ts から渡す)。
 */
export async function buildManifest(
  env: Env,
  site: {
    published: boolean;
    defaultLang: string;
    publicBase: string;
    css: { path: string; body: string } | null;
    /** テンプレートの作者のスクリプト(template-scripts.ts が /_tjs/ へ移したもの)。 */
    scripts?: Array<{ path: string; body: string }>;
  },
): Promise<Manifest> {
  const files: Record<string, ManifestFile> = {};
  const inline = new Map<string, string>();
  const pages = new Map<string, { path: string; lang: string }>();
  if (!site.published) return { files, inline, pages };
  const rows = await env.DB.prepare(
    "SELECT path, lang, hash, size FROM asset_pages",
  ).all<{ path: string; lang: string; hash: string; size: number }>();
  for (const r of rows.results ?? []) {
    files[pageAssetPath(r.path, r.lang, site.defaultLang, site.publicBase)] = {
      hash: r.hash,
      size: r.size,
      type: "text/html; charset=utf-8",
    };
    pages.set(r.hash, { path: r.path, lang: r.lang });
  }
  if (site.css) {
    const b64 = toBase64(site.css.body);
    const hash = await assetHash(site.css.body);
    files[site.css.path] = {
      hash,
      size: new TextEncoder().encode(site.css.body).length,
      type: "text/css; charset=utf-8",
    };
    inline.set(hash, b64);
  }
  for (const js of site.scripts ?? []) {
    const hash = await assetHash(js.body);
    files[js.path] = {
      hash,
      size: new TextEncoder().encode(js.body).length,
      type: "text/javascript; charset=utf-8",
    };
    inline.set(hash, toBase64(js.body));
  }
  return { files, inline, pages };
}

/** 一覧の指紋(パスとハッシュの組を並べた SHA-256)。前回登録した一覧と同じかを見る。 */
export async function manifestFingerprint(
  files: Record<string, ManifestFile>,
  /** `_headers` の中身。空なら前と同じ指紋(見出しを持たなかった版からの続き)。 */
  headers = "",
): Promise<string> {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p} ${files[p]!.hash} ${files[p]!.type}`)
    .join("\n");
  return assetHash(headers ? `${lines}\n_headers ${headers}` : lines);
}

export function lastFingerprint(result: string): string | null {
  try {
    return (
      (JSON.parse(result || "{}") as { manifest?: string }).manifest ?? null
    );
  } catch {
    return null;
  }
}

/**
 * 登録の進み具合。ビルドの回の終わりの知らせ(done)に載せ、管理画面が「進んだか」
 * を判断する —— 登録だけを進める回は新しいページを作らないので、ページの数では
 * 進みが見えない。remaining: 残りのファイル数(分からなければ null)。
 */
export interface AssetsProgress {
  done: boolean;
  status: string;
  error?: string;
  uploaded?: number;
  remaining?: number | null;
}

/** 終わったのに番人へ渡せていないビルドがあるか(予定公開の自動ビルドが見る)。 */
export async function assetsPending(env: Env): Promise<boolean> {
  if (!env.WORKEROPS) return false;
  const st = await env.DB.prepare(
    "SELECT requested_at, published_for FROM asset_publish WHERE id = 1",
  )
    .first<{ requested_at: string; published_for: string }>()
    .catch(() => null);
  return !!st?.requested_at && st.requested_at !== st.published_for;
}

/**
 * ビルドの終わりに番人へ渡す。`request` はビルドが終わったことを記録してから
 * 渡す。`force` はビルドの有無を見ずに渡す(サイトを非公開にしたとき)。
 * `done: false` なら登録は済んでいない —— ビルドは「続きあり」で返す。
 * 決して投げない。
 */
export async function publishAssets(
  env: Env,
  deps: {
    site: () => Promise<
      Parameters<typeof buildManifest>[1] & {
        /** 静的資産の応答に付ける見出し(`_headers` の中身・site-csp.ts)。 */
        headers?: string;
      }
    >;
    /** Every language of one page (one KV read for a bundled page). */
    readPage: (path: string) => Promise<Record<string, string>>;
  },
  opts: {
    force?: boolean;
    request?: boolean;
    now?: number;
    maxReads?: number;
  } = {},
): Promise<AssetsProgress> {
  try {
    if (!env.WORKEROPS) return { done: true, status: "no_binding" };
    const at = new Date(opts.now ?? Date.now()).toISOString();
    let st = await env.DB.prepare(
      "SELECT requested_at, published_for, result FROM asset_publish WHERE id = 1",
    ).first<{ requested_at: string; published_for: string; result: string }>();
    if (!st) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO asset_publish (id) VALUES (1)",
      ).run();
      st = { requested_at: "", published_for: "", result: "" };
    }
    if (opts.request) {
      // A mark unique to this build (not just its time): two builds in the same
      // millisecond must still be two hand-overs.
      const mark = `${at}#${crypto.randomUUID()}`;
      await env.DB.prepare(
        "UPDATE asset_publish SET requested_at = ? WHERE id = 1",
      )
        .bind(mark)
        .run();
      st = { ...st, requested_at: mark };
    }
    const requested = st.requested_at;
    if (!opts.force && (!requested || requested === st.published_for))
      return { done: true, status: "current" };

    const site = await deps.site();
    const manifest = await buildManifest(env, site);
    // 公開していないサイトには見出しも渡さない(資産が無い)。
    const headers = site.published ? (site.headers ?? "") : "";
    // Nothing changed since the last registration (a rebuild with the same
    // output): don't make a version that is the same as the one serving. It
    // took ~5 s per build and added a version each time (measured 2026-10-16).
    // 見出し(CSP)も指紋に入れる —— 設定(GA・AdSense)だけが変わった時も版を出し直す。
    const fingerprint = await manifestFingerprint(manifest.files, headers);
    if (!opts.force && lastFingerprint(st.result) === fingerprint) {
      await env.DB.prepare(
        "UPDATE asset_publish SET published_for = ? WHERE id = 1",
      )
        .bind(requested)
        .run();
      return { done: true, status: "unchanged" };
    }
    // One KV read per page (a bundle holds every language): remember them.
    const bundles = new Map<string, Promise<Record<string, string>>>();
    let reads = 0;
    const maxReads = opts.maxReads ?? 100;
    const read = async (hashes: string[]) => {
      const out: Array<{ hash: string; base64: string }> = [];
      for (const h of hashes) {
        const css = manifest.inline.get(h);
        if (css !== undefined) {
          out.push({ hash: h, base64: css });
          continue;
        }
        const page = manifest.pages.get(h);
        if (!page) continue;
        let bundle = bundles.get(page.path);
        if (!bundle) {
          if (reads >= maxReads) continue;
          reads++;
          bundle = deps.readPage(page.path).catch(() => ({}));
          bundles.set(page.path, bundle);
        }
        const html = (await bundle)[page.lang] ?? null;
        // 一覧を作ってから中身が変わったページは返さない(番人は版を出さずに
        // 失敗し、次の回に新しい一覧で渡し直す)。
        if (html === null) continue;
        if ((await assetHash(html)) !== h) continue;
        out.push({ hash: h, base64: toBase64(html) });
      }
      return out;
    };
    // 見出しは番人の既存の受け口(資産の設定)で渡し、番人が版の assets.config._headers に
    // 入れる(番人は最初の版からこの口を持つ —— cms-cms-security「CSP」)。
    const res = await env.WORKEROPS.publish(
      manifest.files,
      read,
      headers ? { config: { _headers: headers } } : undefined,
    );
    const result = JSON.stringify({
      at,
      status: res.status,
      files: res.files,
      uploaded: res.uploaded,
      error: res.error,
      // Only a registered list is remembered: a failed one must be sent again.
      ...(res.ok ? { manifest: fingerprint } : {}),
    }).slice(0, 500);
    if (res.ok) {
      await env.DB.prepare(
        "UPDATE asset_publish SET published_for = ?, published_at = ?, result = ? WHERE id = 1",
      )
        .bind(requested, at, result)
        .run();
    } else {
      await env.DB.prepare("UPDATE asset_publish SET result = ? WHERE id = 1")
        .bind(result)
        .run();
    }
    return {
      done: res.ok,
      status: res.status,
      error: res.error,
      uploaded: res.uploaded ?? 0,
      remaining: res.ok ? 0 : (res.remaining ?? null),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE asset_publish SET result = ? WHERE id = 1")
      .bind(
        JSON.stringify({
          at: new Date().toISOString(),
          status: "error",
          error,
        }).slice(0, 500),
      )
      .run()
      .catch(() => {});
    return { done: false, status: "error", error };
  }
}
