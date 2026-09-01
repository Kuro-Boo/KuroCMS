/**
 * サイトの時計（site_settings.site_timezone）。
 *
 * ⚠ なぜ要るか: `documents.publish_at` は保存時に UTC(`...Z`) へ潰されている
 * （エディタの `localDateTimeInputToIso`）。一方で公開ページの日付は
 * `data-kuro-local-date` から **閲覧者の TZ** で hydration していたので、
 * 「ビルド側 = UTC / 表示側 = 閲覧者 TZ」の 2 つの時計が並走していた。
 * JST 00:00〜08:59 の記事は UTC では前日・前月に落ちるため、`/monthly/`
 * アーカイブに翌月 1 日の記事が混ざる（8 月を選ぶと 9/1 が出る）。
 * 月の区切りも表示もこのモジュールの 1 つの TZ に寄せて食い違いを無くす。
 *
 * ⚠ SQL 側で `datetime(x, '+9 hours')` のような固定オフセットにしないこと。
 * IANA タイムゾーンは DST で年内にオフセットが変わり、行ごとに正解が違う。
 * 月 → UTC 区間の変換はここ（`monthRangeUtc`）で行い、SQL には境界 2 つを
 * bind する。
 */

/** 設定値 → 実際に使う IANA 名。未設定・壊れた値は UTC（従来の挙動）。 */
export function resolveTimeZone(tz: string | null | undefined): string {
  const value = (tz || "").trim();
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return value;
  } catch {
    return "UTC";
  }
}

/** Intl が受け付ける IANA 名か（設定保存時の検証用）。空文字も許す（= UTC）。 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, fmt);
  }
  return fmt;
}

/** ある瞬間を tz で読んだときの壁時計。 */
function wallClock(instant: Date, tz: string): WallClock {
  const parts = wallClockFormatter(tz).formatToParts(instant);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type)?.value ?? "0";
    return parseInt(found, 10);
  };
  // hour12:false でも実装によっては 24 時が出るので 0 に畳む。
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** tz のその瞬間の UTC からのオフセット（ミリ秒）。 */
function offsetMs(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * tz の壁時計 → その瞬間（UTC）。オフセットは求めたい瞬間に依存するので
 * 2 回収束させる（DST 境界をまたぐ月初でも 1 回では足りない）。
 */
function wallClockToInstant(
  tz: string,
  year: number,
  month: number,
  day = 1,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = guess - offsetMs(new Date(guess), tz);
  ms = guess - offsetMs(new Date(ms), tz);
  return new Date(ms);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO 文字列 → tz で読んだ 'YYYY-MM'。不正な値は ""。 */
export function zonedMonth(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const w = wallClock(d, tz);
  return `${w.year}-${pad2(w.month)}`;
}

/** 今この瞬間の tz での 'YYYY-MM'。 */
export function currentZonedMonth(tz: string, now: Date = new Date()): string {
  const w = wallClock(now, tz);
  return `${w.year}-${pad2(w.month)}`;
}

/**
 * 'YYYY-MM'（tz の暦月）→ 突き合わせに使う UTC 半開区間 [start, end)。
 * SQL には ISO 文字列 2 つを bind する。月が壊れていれば null。
 */
export function monthRangeUtc(
  month: string,
  tz: string,
): { startIso: string; endIso: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const start = wallClockToInstant(tz, year, mon);
  const end =
    mon === 12
      ? wallClockToInstant(tz, year + 1, 1)
      : wallClockToInstant(tz, year, mon + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** ビルド時に埋め込む日付の各表記を tz で作る（hydration 前の初期表示）。 */
export function zonedDateParts(
  iso: string | null | undefined,
  tz: string,
): { year: number; month: number; day: number; weekday: number } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const w = wallClock(d, tz);
  // 曜日は tz の暦日から求める（UTC 基準の getDay() では 1 日ずれる）。
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  return { year: w.year, month: w.month, day: w.day, weekday };
}
