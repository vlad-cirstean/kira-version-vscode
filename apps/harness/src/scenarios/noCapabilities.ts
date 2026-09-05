import { detail } from "./detail.ts";
import type { Scenario } from "./types.ts";

/**
 * P5 W12's feature-detection scenario: the same commit and fixture data as `detail`, with every
 * `app.init` capability false — so "Open in editor", "Go to file" and the four copy sites all
 * render as absent (not merely disabled) and nothing throws reaching for a port the host doesn't
 * have.
 */
export const noCapabilities: Scenario = {
  ...detail,
  name: "noCapabilities",
  repoOpen:
    detail.repoOpen.kind === "ok"
      ? {
          kind: "ok",
          repo: { ...detail.repoOpen.repo, repoId: "/repos/noCapabilities" },
        }
      : detail.repoOpen,
  capabilities: { openInEditor: false, goToFile: false, clipboard: false },
};
