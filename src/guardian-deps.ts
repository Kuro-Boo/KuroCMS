/** guardian-update.ts に本番の外とのやり取りを渡す(試験では差し替える)。 */
import { GUARDIAN_PRODUCT, type GuardianDeps } from "./guardian-update";
import {
  fetchUpdateArtifact,
  fetchUpdateManifest,
  updateChannelVersion,
} from "./release-source";
import { reportGuardian } from "./release-report";
import type { Env } from "./types";
import { KUROCMS_VERSION } from "./version";

export function guardianDeps(env: Env): GuardianDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    report: (code, detail) => reportGuardian(env, code, detail),
    appVersion: KUROCMS_VERSION,
    channelVersion: (channel) =>
      updateChannelVersion(channel, GUARDIAN_PRODUCT),
    fetchCode: async (version) => {
      const manifest = await fetchUpdateManifest(version, GUARDIAN_PRODUCT);
      const mainModule =
        (manifest as unknown as { main_module?: string }).main_module ||
        "worker.js";
      return {
        mainModule,
        code: await fetchUpdateArtifact(manifest, mainModule),
      };
    },
  };
}
