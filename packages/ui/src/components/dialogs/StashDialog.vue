<script setup lang="ts">
/**
 * `docs/plans/P9.md` W14 (§3.1's normative tree names exactly one `StashDialog.vue`, unlike
 * `BranchDialog.vue`/`TagDialog.vue`/`RevertDialog.vue`'s one-dialog-per-file precedent — see this
 * plan's own Findings for why all three of its "collect input" moments live in this one file
 * rather than being split further to match that precedent):
 *
 * - **create** — `runStashPush`'s own confirm step (no pre-flight endpoint exists for it).
 * - **branch** — name entry plus `previewStashBranch`'s live pre-flight, re-run on every keystroke
 *   exactly like `RevertDialog.vue`'s own mainline picker re-runs `previewRevertMainline`.
 * - **popConfirm** — the shared apply/pop confirmation (OQ7), driven directly by
 *   `ops.pendingStashPop` with no props of its own, exactly like `RevertDialog.vue`/
 *   `CheckoutDialog.vue` are driven by their own `ops.pending*` fields.
 *
 * At most one mode is ever active — `mode` below picks in that order (create/branch never overlap
 * `popConfirm` in practice, since `previewStashBranch` never opens `ops.pendingStashPop`, but the
 * order still matters if a caller opened `createOpen`/`branchTarget` while a pop confirmation from
 * an unrelated row happened to already be pending).
 */
import { validateRefName } from "@kira-version/core";
import type { StashBranchPreflight, StashEntry } from "@kira-version/ipc";
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{
  ops: OpsState;
  /** Toggled by `AppToolbar.vue`'s "Stash changes…" button, via `App.vue`. */
  createOpen: boolean;
  /** `kiraVersion.stash.includeUntracked`'s current value — the create form's own default,
   *  re-read fresh every time the dialog opens (a setting change mid-session should be seen the
   *  next time this opens, not only after a reload). */
  includeUntrackedDefault: boolean;
  /** Set by `StashList.vue`'s "Create branch from stash…" row action, via `BranchPicker.vue` →
   *  `App.vue`; `undefined` when branch mode is not open. */
  branchTarget: StashEntry | undefined;
}>();

const emit = defineEmits<{
  (e: "close-create"): void;
  (e: "close-branch"): void;
}>();

type Mode = "create" | "branch" | "popConfirm" | undefined;

const mode = computed<Mode>(() => {
  if (props.ops.pendingStashPop.value) return "popConfirm";
  if (props.branchTarget !== undefined) return "branch";
  if (props.createOpen) return "create";
  return undefined;
});

const active = computed(() => mode.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

// ---------------------------------------------------------------------------------------
// create mode
// ---------------------------------------------------------------------------------------

const message = ref("");
const includeUntracked = ref(props.includeUntrackedDefault);
const keepIndex = ref(false);
/** OQ9: wired from the caller's current changed-files selection when non-empty (`App.vue` passes
 *  it through `createOpen`'s own open call — see that wiring's own comment); empty means "whole
 *  worktree", never a half-wired guess. Shown here as a read-only summary, not an editable field —
 *  there is no staging UI in this app to pick a *different* subset from. */
const pathspec = ref<readonly string[]>([]);

watch(
  () => props.createOpen,
  (isOpen) => {
    if (!isOpen) return;
    message.value = "";
    includeUntracked.value = props.includeUntrackedDefault;
    keepIndex.value = false;
  },
);

function cancelCreate(): void {
  emit("close-create");
}

async function submitCreate(): Promise<void> {
  await props.ops.runStashPush({
    message: message.value.trim() === "" ? undefined : message.value.trim(),
    includeUntracked: includeUntracked.value,
    keepIndex: keepIndex.value,
    paths: pathspec.value,
  });
  emit("close-create");
}

// ---------------------------------------------------------------------------------------
// branch mode
// ---------------------------------------------------------------------------------------

const branchName = ref("");
const branchPreflight = ref<StashBranchPreflight | undefined>(undefined);
let previewToken = 0;

watch(
  () => props.branchTarget,
  (entry) => {
    if (entry === undefined) return;
    branchName.value = "";
    branchPreflight.value = undefined;
  },
);

watch(branchName, async (name) => {
  const entry = props.branchTarget;
  const trimmed = name.trim();
  if (entry === undefined || trimmed === "") {
    branchPreflight.value = undefined;
    return;
  }
  const token = ++previewToken;
  const result = await props.ops.previewStashBranch(entry, trimmed);
  // A later keystroke's own preview may have already resolved and been rendered by the time this
  // one comes back — `previewRevertMainline`'s call sites have no comparable race (a mainline
  // pick fires once, not once per keystroke), so this dialog needs its own guard against a slow,
  // stale response clobbering a newer one.
  if (token === previewToken) branchPreflight.value = result;
});

const branchNameLocalError = computed(() => {
  if (branchName.value.trim() === "") return undefined;
  const { valid, error } = validateRefName(branchName.value.trim());
  return valid ? undefined : error;
});

/** Only a genuinely invalid/taken name (or nothing typed yet) blocks the button — a `blocked`
 *  checkout half (OQ6) still lets the user create the branch; §7.6/probe 11's own point is that
 *  the branch creation always succeeds, only the pop half can fail, and OQ6's recommendation is to
 *  say so plainly afterward rather than refuse the attempt up front. */
const canSubmitBranch = computed(
  () =>
    branchName.value.trim() !== "" &&
    branchNameLocalError.value === undefined &&
    branchPreflight.value !== undefined &&
    branchPreflight.value.verdict !== "invalidName",
);

function cancelBranch(): void {
  emit("close-branch");
}

async function submitBranch(): Promise<void> {
  const entry = props.branchTarget;
  if (entry === undefined || !canSubmitBranch.value) return;
  await props.ops.runStashBranch(entry, branchName.value.trim());
  emit("close-branch");
}

// ---------------------------------------------------------------------------------------
// popConfirm mode (OQ7: one dialog, verb and one sentence differ)
// ---------------------------------------------------------------------------------------

const pending = computed(() => props.ops.pendingStashPop.value);

function cancelPop(): void {
  props.ops.resolveStashPopDialog(false);
}

function confirmPop(): void {
  props.ops.resolveStashPopDialog(true);
}
</script>

<template>
  <div v-if="active" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-stash-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="mode === 'create' ? cancelCreate() : mode === 'branch' ? cancelBranch() : cancelPop()"
    >
      <template v-if="mode === 'create'">
        <h2 id="kv-stash-dialog-title" class="kv-modal-title">Stash changes</h2>
        <label class="kv-tag-field">
          Message (optional)
          <input type="text" v-model="message" autofocus placeholder="git's own WIP message" />
        </label>
        <label class="kv-tag-field kv-tag-field--inline">
          <input type="checkbox" v-model="includeUntracked" />
          Include untracked files (<code>-u</code>)
        </label>
        <label class="kv-tag-field kv-tag-field--inline">
          <input type="checkbox" v-model="keepIndex" />
          Keep staged changes staged (<code>--keep-index</code>)
        </label>
        <p v-if="pathspec.length > 0" class="kv-modal-note">
          Only {{ pathspec.length }} selected file{{ pathspec.length === 1 ? "" : "s" }} will be
          stashed, not the whole working tree.
        </p>
        <div class="kv-modal-actions">
          <button type="button" class="kv-modal-button kv-modal-button--primary" @click="submitCreate">
            Stash
          </button>
          <button type="button" class="kv-modal-button" @click="cancelCreate">Cancel</button>
        </div>
      </template>

      <template v-else-if="mode === 'branch'">
        <h2 id="kv-stash-dialog-title" class="kv-modal-title">Create branch from stash</h2>
        <p class="kv-modal-note">
          From <code>{{ `stash@{${branchTarget?.index}}` }}</code>: {{ branchTarget?.message }}
        </p>
        <label class="kv-tag-field">
          Branch name
          <input type="text" v-model="branchName" autofocus />
        </label>
        <p v-if="branchNameLocalError" class="kv-modal-error">{{ branchNameLocalError }}</p>
        <p v-else-if="branchPreflight?.name.error" class="kv-modal-error">
          {{ branchPreflight.name.error }}
        </p>
        <div v-if="branchPreflight?.verdict === 'blocked'" class="kv-revert-prediction">
          <p>
            The branch will be created, but switching to it will not be clean — your working tree
            has changes that would be overwritten. You will stay on your current branch until you
            resolve that yourself.
          </p>
        </div>
        <div class="kv-modal-actions">
          <button
            type="button"
            class="kv-modal-button kv-modal-button--primary"
            :disabled="!canSubmitBranch"
            @click="submitBranch"
          >
            Create branch
          </button>
          <button type="button" class="kv-modal-button" @click="cancelBranch">Cancel</button>
        </div>
      </template>

      <template v-else-if="mode === 'popConfirm' && pending">
        <h2 id="kv-stash-dialog-title" class="kv-modal-title">
          {{ pending.verb === "pop" ? "Pop" : "Apply" }}
          {{ `stash@{${pending.preflight.stashIndex}}` }}
        </h2>

        <template v-for="blocker in pending.preflight.blockers" :key="blocker.kind">
          <div v-if="blocker.kind === 'untrackedCollision'" class="kv-revert-prediction kv-revert-prediction--conflict">
            <p>These untracked files already exist in your working tree and would be overwritten:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in blocker.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
            <p>Remedy: move or remove them first, or discard them and try again.</p>
          </div>
          <div
            v-else-if="blocker.kind === 'localChangesWouldBeOverwritten'"
            class="kv-revert-prediction kv-revert-prediction--conflict"
          >
            <p>Your uncommitted changes to these files would be overwritten:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in blocker.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
            <p>Remedy: commit or discard those changes first.</p>
          </div>
          <div v-else class="kv-revert-prediction kv-revert-prediction--conflict">
            <p>An operation is already in progress — finish or abort it first.</p>
          </div>
        </template>

        <template v-if="pending.preflight.blockers.length === 0">
          <div v-if="pending.preflight.prediction.kind === 'clean'" class="kv-revert-prediction kv-revert-prediction--clean">
            No conflicts predicted.
          </div>
          <div v-else-if="pending.preflight.prediction.kind === 'conflicts'" class="kv-revert-prediction kv-revert-prediction--conflict">
            <p>This will likely conflict in:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in pending.preflight.prediction.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
            <p>
              Your stash stays in the list either way{{ pending.verb === "pop" ? " if this conflicts" : "" }}
              — nothing is lost.
            </p>
          </div>
          <div v-else class="kv-revert-prediction">
            Couldn't predict the outcome: {{ pending.preflight.prediction.reason }}
          </div>
        </template>

        <div class="kv-modal-actions">
          <button type="button" class="kv-modal-button kv-modal-button--primary" @click="confirmPop">
            {{ pending.preflight.verdict === "blocked" ? "Force" : "" }}
            {{ pending.verb === "pop" ? "Pop" : "Apply" }} anyway
          </button>
          <button type="button" class="kv-modal-button" @click="cancelPop">Cancel</button>
        </div>
      </template>
    </div>
  </div>
</template>

<!-- No `<style>` block: every class this template uses (`.kv-modal-*`, `.kv-tag-field*`,
     `.kv-revert-prediction*`) is already declared, unscoped, by `CheckoutDialog.vue`/
     `TagDialog.vue`/`RevertDialog.vue` — `App.vue` always mounts all of them alongside this file,
     so redeclaring any of it here would only be duplicate CSS. -->

