// JobCard(求人)・ContactForm(問い合わせフォーム)のサーバー側検証(仕様 cms-job 2節・cms-contact)。
//
// recipe-guard.ts と同じ考え: 本文は誰でも書ける(管理画面・REST・MCP・取り込み)ので、保存の口で必ず確かめ直す。
// 判定は KuroEditor の純関数(src/job.js・src/contact.js)に任せ、エディタとサーバーで別の判定を持たない。
// トップレベルの分解は共有の tokenizer(parseBlocks)、開始タグの読み方は recipe-guard.ts と同じ関数を使う。

import { parseBlocks } from "../../KuroEditor/src/blocks.js";
import {
  JOB_BLOCK,
  decodeJob,
  normalizeJob,
  validateJob,
  type Job,
} from "../../KuroEditor/src/job.js";
import {
  CONTACT_BLOCK,
  CONTACT_LIMITS,
  decodeContactForm,
  normalizeContactForm,
  validateContactForm,
  type ContactForm,
} from "../../KuroEditor/src/contact.js";
import { attrNames, attrValue, openingTag } from "./recipe-guard.ts";

const COMMON_ATTRS = [
  "data-kuro-block",
  "contenteditable",
  "role",
  "aria-label",
  "data-bid",
];
const JOB_ATTRS = new Set([...COMMON_ATTRS, "data-job-version", "data-job"]);
const CONTACT_ATTRS = new Set([
  ...COMMON_ATTRS,
  "data-contact-version",
  "data-contact",
]);

function cardsOf(bodyHtml: string, block: string): string[] {
  return parseBlocks(bodyHtml ?? "")
    .map((seg) => openingTag(seg.html))
    .filter((tag) => attrValue(tag, "data-kuro-block") === block);
}

export interface JobCheck {
  count: number;
  errors: string[];
  /** 検証を通った 1 件(0 件・誤りのときは null)。 */
  job: Job | null;
}

/** 本文の求人カードを確かめる。1 本文に 1 個まで(1 記事 = 1 求人)。 */
export function checkJobCards(bodyHtml: string): JobCheck {
  const errors: string[] = [];
  const cards = cardsOf(bodyHtml, JOB_BLOCK);
  if (cards.length > 1)
    errors.push(
      `求人カードは 1 記事に 1 つだけです(${cards.length} 個あります)。`,
    );
  let job: Job | null = null;
  for (const tag of cards) {
    const unknown = attrNames(tag).filter((n) => !JOB_ATTRS.has(n));
    if (unknown.length)
      errors.push(`求人カードに知らない属性があります: ${unknown.join(", ")}`);
    const version = attrValue(tag, "data-job-version");
    if (version !== "1")
      errors.push(`知らない求人カードの版です: ${version ?? "(なし)"}`);
    const decoded = decodeJob(attrValue(tag, "data-job"));
    if (!decoded) {
      errors.push(
        "求人カードの内容を読み取れません(data-job が壊れています)。",
      );
      continue;
    }
    const normalized = normalizeJob(decoded);
    const contentErrors = validateJob(normalized);
    errors.push(...contentErrors);
    if (!contentErrors.length && cards.length === 1) job = normalized;
  }
  return { count: cards.length, errors, job: errors.length ? null : job };
}

export interface ContactCheck {
  count: number;
  errors: string[];
  forms: ContactForm[];
}

/** 本文の問い合わせフォームを確かめる。1 本文に CONTACT_LIMITS.perBody 個まで。 */
export function checkContactForms(bodyHtml: string): ContactCheck {
  const errors: string[] = [];
  const forms: ContactForm[] = [];
  const cards = cardsOf(bodyHtml, CONTACT_BLOCK);
  if (cards.length > CONTACT_LIMITS.perBody) {
    errors.push(
      `問い合わせフォームは 1 つの本文に ${CONTACT_LIMITS.perBody} 個までです(${cards.length} 個あります)。`,
    );
  }
  for (const tag of cards) {
    const unknown = attrNames(tag).filter((n) => !CONTACT_ATTRS.has(n));
    if (unknown.length)
      errors.push(
        `問い合わせフォームに知らない属性があります: ${unknown.join(", ")}`,
      );
    const version = attrValue(tag, "data-contact-version");
    if (version !== "1")
      errors.push(`知らない問い合わせフォームの版です: ${version ?? "(なし)"}`);
    const decoded = decodeContactForm(attrValue(tag, "data-contact"));
    if (!decoded) {
      errors.push(
        "問い合わせフォームの内容を読み取れません(data-contact が壊れています)。",
      );
      continue;
    }
    const normalized = normalizeContactForm(decoded);
    const contentErrors = validateContactForm(normalized);
    errors.push(...contentErrors);
    if (!contentErrors.length) forms.push(normalized);
  }
  return { count: cards.length, errors, forms };
}

/** 保存の口で使う: 求人カードとフォームの誤りをまとめて返す(誤りの符号ごと)。 */
export function blockGuardErrors(
  bodyHtml: string,
): { code: string; message: string } | null {
  const job = checkJobCards(bodyHtml);
  if (job.errors.length)
    return { code: "invalid_job_card", message: job.errors.join(" / ") };
  const contact = checkContactForms(bodyHtml);
  if (contact.errors.length)
    return {
      code: "invalid_contact_form",
      message: contact.errors.join(" / "),
    };
  return null;
}
