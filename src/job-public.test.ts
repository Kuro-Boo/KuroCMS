// 契約テスト (node で直接実行)。求人カードと JobPosting(cms-job)。
//
// 固定したいのは ——「募集中で期限内の求人だけが構造化データと一覧に出る・1 記事 = 1 求人・値は見えるカードから」。
import assert from "node:assert/strict";
import { renderTemplate } from "./templates/html-template.ts";
import { buildJobCardHtml, normalizeJob } from "../../KuroEditor/src/job.js";
import {
  buildContactCardHtml,
  normalizeContactForm,
  emptyContactForm,
} from "../../KuroEditor/src/contact.js";
import {
  blockGuardErrors,
  checkJobCards,
  checkContactForms,
} from "./block-guard.ts";
import {
  bodyWithoutJobCard,
  jobOfBody,
  jobPostingLd,
  openJobItems,
  todayIn,
  toJobData,
} from "./job-public.ts";

const JOB = normalizeJob({
  open: true,
  openedAt: "2026-11-21",
  employmentType: ["PART_TIME"],
  salary: { currency: "JPY", unit: "HOUR", min: 1500 },
  location: {
    country: "JP",
    postalCode: "277-0825",
    region: "千葉県",
    locality: "柏市",
    street: "布施138-5",
  },
  hours: "4 時間〜",
  requirements: "資格は問いません",
});
const card = (j = JOB) => buildJobCardHtml(j);
const body = `<p>ガイドヘルパーの仕事です。</p>${card()}<p>見学もできます。</p>`;

// 保存の口: 1 記事に 2 つは断る・壊れた正本は断る・知らない属性は断る
assert.equal(checkJobCards(body).errors.length, 0);
assert.equal(checkJobCards(body).job?.salary?.min, 1500);
assert.match(blockGuardErrors(card() + card())!.code, /invalid_job_card/);
assert.match(
  blockGuardErrors(card().replace(/data-job="[^"]*"/, 'data-job="%7Bbroken"'))!
    .message,
  /読み取れません/,
);
assert.match(
  blockGuardErrors(card().replace("<div ", '<div onclick="x()" '))!.message,
  /知らない属性/,
);
assert.match(
  blockGuardErrors(card(normalizeJob({ ...JOB, employmentType: [] })))!.message,
  /雇用形態/,
);
// フォームは 3 個まで
const f = buildContactCardHtml(normalizeContactForm(emptyContactForm()));
assert.equal(checkContactForms(f + f + f).errors.length, 0);
assert.match(blockGuardErrors(f + f + f + f)!.code, /invalid_contact_form/);
assert.equal(blockGuardErrors("<p>ふつうの本文</p>"), null);

// JobPosting: 値は見えるカードと記事から。説明は本文(カードを除く)
const ld = jobPostingLd({
  job: JOB,
  today: "2026-11-25",
  title: "ガイドヘルパー",
  bodyHtml: body,
  siteName: "はなみずき",
  siteUrl: "https://hanamizuki.example/",
  canonical: "https://hanamizuki.example/job/guide/",
})!;
assert.equal(ld["@type"], "JobPosting");
assert.equal(ld.title, "ガイドヘルパー");
assert.equal(ld.datePosted, "2026-11-21");
assert.equal(ld.employmentType, "PART_TIME");
assert.deepEqual((ld.baseSalary as any).value, {
  "@type": "QuantitativeValue",
  value: 1500,
  unitText: "HOUR",
});
assert.equal((ld.baseSalary as any).currency, "JPY");
assert.equal((ld.jobLocation as any).address.addressLocality, "柏市");
assert.equal((ld.hiringOrganization as any).name, "はなみずき");
assert.equal(
  ld.validThrough,
  undefined,
  "期限の無い求人は validThrough を出さない",
);
assert.doesNotMatch(String(ld.description), /data-kuro-block/);
{
  const withBid = jobPostingLd({
    job: JOB,
    today: "2026-11-25",
    title: "x",
    bodyHtml: '<p data-bid="b1">説明</p>' + card(),
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.equal(
    withBid.description,
    "<p>説明</p>",
    "data-bid を公開物に出さない",
  );
}
assert.match(String(ld.description), /ガイドヘルパーの仕事です/);
assert.equal(
  bodyWithoutJobCard(body),
  "<p>ガイドヘルパーの仕事です。</p><p>見学もできます。</p>",
);

// 待遇・募集人数・問い合わせ先: カードに見える値から。「数名」は人数にしない
{
  const more = normalizeJob({
    ...JOB,
    benefits: "賞与 年2回\n労災保険",
    openings: "3名",
    contact: "04-7192-6511(本部)",
  });
  const m = jobPostingLd({
    job: more,
    today: "2026-11-25",
    title: "x",
    bodyHtml: card(more),
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.equal(m.jobBenefits, "賞与 年2回\n労災保険");
  assert.equal(m.totalJobOpenings, 3);
  assert.deepEqual(m.applicationContact, {
    "@type": "ContactPoint",
    description: "04-7192-6511(本部)",
    telephone: "04-7192-6511",
  });
  const vague = jobPostingLd({
    job: normalizeJob({ ...more, openings: "数名" }),
    today: "2026-11-25",
    title: "x",
    bodyHtml: "",
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.equal(vague.totalJobOpenings, undefined);
  assert.equal(toJobData(more, "2026-11-25").openings, "3名");
}

// 本文がカードだけのときは、カードの表(頁に見えている条件)を説明にする
{
  const only = jobPostingLd({
    job: JOB,
    today: "2026-11-25",
    title: "x",
    bodyHtml: card(),
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.match(String(only.description), /^<table class="kuro-job__table">/);
  assert.match(String(only.description), /時給 1,500円〜/);
  assert.doesNotMatch(String(only.description), /募集中/);
}

// 概要(リード)は説明の頭に置く(頁で本文の上に出すので、説明から抜かない)。文字はエスケープする
{
  const withLead = jobPostingLd({
    job: JOB,
    today: "2026-11-25",
    title: "x",
    bodyHtml: body,
    summary: "利用者の外出を\nお手伝いする<仕事>です",
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.match(
    String(withLead.description),
    /^<p>利用者の外出を<br>お手伝いする&lt;仕事&gt;です<\/p><p>ガイドヘルパーの仕事です。<\/p>/,
  );
  const leadOnly = jobPostingLd({
    job: JOB,
    today: "2026-11-25",
    title: "x",
    bodyHtml: card(),
    summary: "外出のお手伝い",
    siteName: "s",
    siteUrl: "u",
  })!;
  assert.match(
    String(leadOnly.description),
    /^<p>外出のお手伝い<\/p><table class="kuro-job__table">/,
    "本文がカードだけなら、概要のあとにカードの表",
  );
}

// 募集を止めた・期限を過ぎた求人は JobPosting を出さない
assert.equal(
  jobPostingLd({
    job: normalizeJob({ ...JOB, open: false }),
    today: "2026-11-25",
    title: "x",
    bodyHtml: body,
    siteName: "s",
    siteUrl: "u",
  }),
  null,
);
const dated = normalizeJob({ ...JOB, validThrough: "2026-11-30" });
assert.equal(
  jobPostingLd({
    job: dated,
    today: "2026-12-01",
    title: "x",
    bodyHtml: body,
    siteName: "s",
    siteUrl: "u",
  }),
  null,
);
assert.equal(
  jobPostingLd({
    job: dated,
    today: "2026-11-30",
    title: "x",
    bodyHtml: body,
    siteName: "s",
    siteUrl: "u",
  })!.validThrough,
  "2026-11-30T23:59:59",
);

// テンプレートへ渡す形
const data = toJobData(JOB, "2026-11-25");
assert.equal(data.open, true);
assert.equal(data.salaryText, "時給 1,500円〜");
assert.equal(data.locationText, "〒277-0825 千葉県柏市布施138-5");
assert.deepEqual(data.employmentLabels, ["パート・アルバイト"]);

// 一覧(jobs:…): 募集中だけ、募集を始めた日の新しい順
const items = openJobItems(
  [
    {
      body_html: card(normalizeJob({ ...JOB, openedAt: "2026-10-01" })),
      card: { slug: "old" },
    },
    {
      body_html: card(normalizeJob({ ...JOB, open: false })),
      card: { slug: "closed" },
    },
    { body_html: "<p>求人ではない記事</p>", card: { slug: "plain" } },
    {
      body_html: card(normalizeJob({ ...JOB, openedAt: "2026-11-20" })),
      card: { slug: "new" },
    },
  ],
  "2026-11-25",
);
assert.deepEqual(
  items.map((i) => i.slug),
  ["new", "old"],
);
assert.equal(items[0].job.open, true);

assert.equal(jobOfBody("<p>x</p>"), null);
assert.equal(
  todayIn("Asia/Tokyo", new Date("2026-11-20T16:30:00Z")),
  "2026-11-21",
);

// テンプレート: いまの固定ページを slug で見分け、募集中の一覧が空なら見出しごと出さない
{
  const tpl =
    "<!-- kurocms-template-api:1 -->[[#if page.staticIs.recruit]]R[[#if jobs:a:5]]<h2>A</h2>[[#each jobs:a:5]]<a>[[title]] [[job.salaryText]]</a>[[/each]][[/if]][[#if jobs:b:5]]<h2>B</h2>[[/if]][[/if]]";
  const render = (slug: string, a: unknown[]) =>
    renderTemplate(tpl, {
      path: `/${slug}/`,
      params: {},
      lang: "ja",
      basePath: "",
      content: {
        "_static-page": JSON.stringify({
          slug,
          title: slug,
          titleHtml: "",
          bodyHtml: "",
        }),
        "_data-refs": JSON.stringify({ "jobs:a:5": a, "jobs:b:5": [] }),
      },
    } as never).replace("<!-- kurocms-template-api:1 -->", "");
  assert.equal(
    render("recruit", [
      { title: "ガイド", job: { salaryText: "時給 1,500円〜" } },
    ]),
    "R<h2>A</h2><a>ガイド 時給 1,500円〜</a>",
  );
  assert.equal(render("about", [{ title: "x", job: {} }]), "");
}

// テンプレート: 記事の頁はカテゴリーの slug で見分けられる(戻るリンク・タブの点灯)。記事でない頁では空
{
  const tpl =
    "<!-- kurocms-template-api:1 -->[[#if page.categoryIs.grouphome]]G[[/if]][[#if page.categoryIs.syurou]]S[[/if]]";
  const render = (article: unknown, cats: unknown[]) =>
    renderTemplate(tpl, {
      path: "/facility/x/",
      params: {},
      lang: "ja",
      basePath: "",
      article,
      content: { "_article-categories": JSON.stringify(cats) },
    } as never).replace("<!-- kurocms-template-api:1 -->", "");
  const art = {
    did: "d",
    slug: "x",
    type: "facility",
    title: "x",
    summary: "",
    bodyHtml: "",
    publishAt: "",
    updatedAt: "",
  };
  assert.equal(
    render(art, [
      { id: "c1", name: "グループホーム", slug: "grouphome", count: 1 },
    ]),
    "G",
  );
  assert.equal(
    render(null, [
      { id: "c1", name: "グループホーム", slug: "grouphome", count: 1 },
    ]),
    "",
  );
}

console.log("job-public: OK");
