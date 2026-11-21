// 求人の公開側(仕様 cms-job 3〜4節): 記事の本文の求人カードから、テンプレートへ渡す形と JobPosting を作る。
//
// ⚠ 表示も構造化データも同じ 1 つの正本(data-job)から作る。見えない値を構造化データにだけ入れない。
// ⚠ 募集中か(open)と期限(validThrough)は、頁を作る日(サイトの時計)で決める。

import { parseBlocks, stripInternalIds } from "../../KuroEditor/src/blocks.js";
import {
  JOB_BLOCK,
  contactTelephone,
  employmentLabels,
  formatLocation,
  formatSalary,
  jobIsOpen,
  openingsCount,
  renderJobPreview,
  type Job,
} from "../../KuroEditor/src/job.js";
import { checkJobCards } from "./block-guard.ts";
import { attrValue, openingTag } from "./recipe-guard.ts";

/** テンプレートへ渡す求人の形(article.job・jobs:… の各項目の job)。 */
export interface JobData {
  [key: string]: string | boolean | string[] | null;
  open: boolean;
  openedAt: string | null;
  validThrough: string | null;
  employmentLabels: string[];
  salaryText: string;
  salaryNote: string;
  locationText: string;
  hours: string;
  requirements: string;
  benefits: string;
  openings: string;
  contact: string;
}

/** サイトの時計の今日(YYYY-MM-DD)。 */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** 本文の求人カードの正本(壊れている・無いときは null)。 */
export function jobOfBody(bodyHtml: string): Job | null {
  return checkJobCards(bodyHtml ?? "").job;
}

export function toJobData(job: Job, today: string): JobData {
  return {
    open: jobIsOpen(job, today),
    openedAt: job.openedAt ?? null,
    validThrough: job.validThrough ?? null,
    employmentLabels: employmentLabels(job),
    salaryText: formatSalary(job),
    salaryNote: job.salaryNote ?? "",
    locationText: formatLocation(job),
    hours: job.hours ?? "",
    requirements: job.requirements ?? "",
    benefits: job.benefits ?? "",
    openings: job.openings ?? "",
    contact: job.contact ?? "",
  };
}

/**
 * JobPosting の description。本文(求人カードを除く)が仕事の説明。本文がカードだけのとき(事業所の説明を
 * 一覧の頁に置くサイトなど)は、カードの表 —— 頁に見えている条件 —— を説明にする(説明の無い求人は載らないため)。
 * 公開物に編集用の内部の印(data-bid)を出さない(cms-cms-build・stripInternalIds)。
 */
export function jobDescription(job: Job, bodyHtml: string): string {
  const body = stripInternalIds(bodyWithoutJobCard(bodyHtml)).trim();
  if (body.replace(/<[^>]*>/g, "").trim()) return body;
  const table = /<table class="kuro-job__table">[\s\S]*<\/table>/.exec(
    renderJobPreview(job),
  );
  return table ? table[0] : "";
}

/** 本文から求人カードを外した HTML(JobPosting の description は仕事の説明 = 本文だけ)。 */
export function bodyWithoutJobCard(bodyHtml: string): string {
  return parseBlocks(bodyHtml ?? "")
    .filter(
      (seg) => attrValue(openingTag(seg.html), "data-kuro-block") !== JOB_BLOCK,
    )
    .map((seg) => seg.html)
    .join("");
}

/**
 * JobPosting の JSON-LD。募集中で期限内のときだけ作る(それ以外は null —— 記事は Article も出さず、頁と
 * BreadcrumbList だけ残す)。
 */
export function jobPostingLd(args: {
  job: Job;
  today: string;
  title: string;
  bodyHtml: string;
  siteName: string;
  siteUrl: string;
  logoUrl?: string | null;
  canonical?: string | null;
}): Record<string, unknown> | null {
  const { job } = args;
  if (!jobIsOpen(job, args.today)) return null;
  const l = job.location;
  const openings = openingsCount(job);
  const tel = contactTelephone(job);
  const salary =
    job.salary && typeof job.salary.min === "number"
      ? {
          baseSalary: {
            "@type": "MonetaryAmount",
            currency: job.salary.currency,
            value: {
              "@type": "QuantitativeValue",
              ...(typeof job.salary.max === "number" &&
              job.salary.max !== job.salary.min
                ? { minValue: job.salary.min, maxValue: job.salary.max }
                : { value: job.salary.min }),
              unitText: job.salary.unit,
            },
          },
        }
      : {};
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: args.title,
    description: jobDescription(job, args.bodyHtml),
    ...(job.openedAt ? { datePosted: job.openedAt } : {}),
    ...(job.validThrough
      ? { validThrough: `${job.validThrough}T23:59:59` }
      : {}),
    employmentType:
      job.employmentType.length === 1
        ? job.employmentType[0]
        : job.employmentType,
    hiringOrganization: {
      "@type": "Organization",
      name: args.siteName,
      sameAs: args.siteUrl,
      ...(args.logoUrl ? { logo: args.logoUrl } : {}),
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressCountry: l.country,
        addressRegion: l.region,
        addressLocality: l.locality,
        ...(l.postalCode ? { postalCode: l.postalCode } : {}),
        ...(l.street ? { streetAddress: l.street } : {}),
      },
    },
    ...salary,
    ...(job.requirements ? { qualifications: job.requirements } : {}),
    ...(job.hours ? { workHours: job.hours } : {}),
    ...(job.benefits ? { jobBenefits: job.benefits } : {}),
    // 人数は「3名」のように数だけのときだけ。「数名」を数に言い換えない(見えない値を作らない)。
    ...(openings !== null ? { totalJobOpenings: openings } : {}),
    ...(job.contact
      ? {
          applicationContact: {
            "@type": "ContactPoint",
            description: job.contact,
            ...(tel ? { telephone: tel } : {}),
          },
        }
      : {}),
    ...(args.canonical ? { url: args.canonical } : {}),
  };
}

/**
 * データ参照 jobs:{カテゴリ}:N の並び: 募集中の求人だけを、募集を始めた日の新しい順に。
 * rows は記事の一覧の行(body_html を持つ)と、その一覧の項目(card)の組。
 */
export function openJobItems<C extends object>(
  rows: { body_html?: string | null; card: C }[],
  today: string,
): (C & { job: JobData })[] {
  const items: (C & { job: JobData })[] = [];
  for (const r of rows) {
    const job = jobOfBody(r.body_html ?? "");
    if (!job || !jobIsOpen(job, today)) continue;
    items.push({ ...r.card, job: toJobData(job, today) });
  }
  return items.sort((a, b) =>
    String(b.job.openedAt ?? "").localeCompare(String(a.job.openedAt ?? "")),
  );
}
