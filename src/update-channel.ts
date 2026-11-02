/**
 * 更新の道(安定版・開発版)を、持ち主が開発アカウントかで決める(仕様 core-feature-flags 2節・2026-11-02)。
 *
 * 開発版を受け取れるのは、持ち主が開発アカウントのサイトだけ。一般のサイトは、保存した値が開発版でも安定版を入れ、
 * 開発版へ切り替える要求は断る(画面で隠すだけにしない)。持ち主が開発アカウントかは、このサイト(導入の口座)の
 * トークンの dev で決め、分からないときは一般として扱う(api.ts の ownerIsDeveloper)。
 */
export type UpdateChannel = "stable" | "latest";

/** 実際に使う道。開発版は開発アカウントのサイトだけ。 */
export function effectiveChannel(
  stored: string | null,
  developer: boolean,
): UpdateChannel {
  return stored === "latest" && developer ? "latest" : "stable";
}

/** その道へ切り替えてよいか。開発版は開発アカウントのサイトだけ。 */
export function channelAllowed(
  channel: UpdateChannel,
  developer: boolean,
): boolean {
  return channel === "stable" || developer;
}
