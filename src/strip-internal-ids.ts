// KuroEditor の内部ブロック識別属性 (data-bid / data-cbid) を、公開 HTML から除去する。
//
// なぜ正規表現一発でないか (F0-2):
//   旧実装は /(<[a-zA-Z][^>]*?)\s+data-bid=.../ だったが、[^>]*? は属性値内の
//   '>' を越えられないため、data-bid の前に title="1 > 0" のような属性があると
//   タグ末尾に到達できず、data-bid を残したまま公開ページへ漏らしていた。
//   ブラウザの outerHTML は属性値内の '>' をエスケープしないので実在の経路。
//
// 方式: HTML 全体を単一の正規表現で処理せず、タグ境界を「引用符の内側を無視して」
//   走査し、単一タグに切り出してから内部属性だけを落とす。これにより属性値内の
//   '>' '<'、単引用符、属性順、data-cbid、入れ子 bid のいずれにも影響されない。
//   DOM の無い Cloudflare Worker で動く。将来は KuroEditor の共有 tokenizer
//   (kuro-blocks.js) へ一本化する (仕様書 §10.7 F0)。

const INTERNAL_ATTR_RE =
  /\s+data-(?:bid|cbid)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function stripInternalIds(html: string): string {
  if (!/\bdata-(?:bid|cbid)\b/.test(html)) return html; // 通常ケース: 未使用なら素通し
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt); // '<' 手前のテキスト。エスケープ済み &lt;… には触れない

    // コメントは中身に '>' を含み得るのでそのまま通す
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    // タグ終端 '>' を、引用符 (" ') の内側を無視して探す
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const tagEnd = j < n ? j + 1 : n; // '>' を含む
    out += html.slice(lt, tagEnd).replace(INTERNAL_ATTR_RE, "");
    i = tagEnd;
  }
  return out;
}
