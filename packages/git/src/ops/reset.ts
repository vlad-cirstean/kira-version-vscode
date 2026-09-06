/**
 * `docs/plans/P10.md` §7.7's reset argv builders. Two, not one: `resetArgs` is the user-selected
 * mode (`soft`/`mixed`/`hard`), while `resetKeepArgs` exists ONLY for the undo replay (probe 9) —
 * `--keep` preserves unrelated local modifications and REFUSES (exit 128, changing nothing)
 * rather than lose work, which is exactly the guarantee an undo needs and no user-selectable mode
 * provides. §7.7 names three modes; a fourth is a spec change, not an implementation choice
 * (Scope boundary), so `resetKeepArgs` is deliberately not exposed as a `ResetMode`.
 */
import type { ResetMode } from "@kira-version/core";

export function resetArgs(mode: ResetMode, target: string): string[] {
  return ["reset", `--${mode}`, target];
}

export function resetKeepArgs(target: string): string[] {
  return ["reset", "--keep", target];
}
