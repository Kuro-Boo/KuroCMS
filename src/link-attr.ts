// [[...]] から来た URL を公開ページの属性値にする(2026-10-11)。
//
// javascript: などの押すと動く URL は空にする。判定は KuroEditor の isSafeUrl
// (エディタと同じ1つ)で、ここでは再実装しない。& < > " は文字参照にする。
import { isSafeUrl } from "./kuroeditor/kuro-links.js";

export function urlAttr(u: string, kind: "href" | "src" = "href"): string {
  const v = isSafeUrl(u, kind) ? String(u ?? "") : "";
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
