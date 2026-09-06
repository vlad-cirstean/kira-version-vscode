<script setup lang="ts">
/**
 * `docs/plans/P10.md` W12: §7.13's confirm step — a near-sibling of `RevertDialog.vue`, opened by
 * `OpsState.runCherryPick` whenever the pre-flight is not a clean, non-merge, not-already-applied
 * single pick (that method's own doc comment). One addition revert has no need of: the non-
 * blocking `alreadyApplied` advisory (probe 6) — it never sets a blocker or changes `verdict`, so
 * it is rendered as its own note rather than folded into the blocker list below.
 */
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ ops: OpsState }>();

const preflight = computed(() => props.ops.pendingCherryPick.value);
const active = computed(() => preflight.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

const selectedMainline = ref<number | undefined>(undefined);
const noCommit = ref(false);

// A genuinely new cherry-pick request (a different sha) resets the choice; a re-preflight for
// the *same* sha — `previewCherryPickMainline`'s own refresh, triggered by the watch just below
// — must not, or picking a mainline would immediately un-pick itself.
watch(
  () => preflight.value?.sha,
  () => {
    selectedMainline.value = undefined;
    noCommit.value = false;
  },
);

watch(selectedMainline, (mainline) => {
  if (mainline !== undefined) void props.ops.previewCherryPickMainline(mainline);
});

const needsMainline = computed(() => (preflight.value?.mainlineRequired.length ?? 0) > 0);
// `classifyCherryPick` files `mainlineRequired` as a `CherryPickBlocker` alongside the real,
// nothing-else-to-do refusals (probe 7's set-intersection blockers, plus the in-progress gate) —
// but unlike those, it has its own dedicated, non-blocking resolution right here (the radio group
// below), the same way `RevertDialog.vue`'s own `needsMainline` never waits on a generic blocker
// list at all. Filtered out here so picking a mainline stays reachable on its own: left in,
// `hasBlocker` would be permanently true the moment `needsMainline` is, the radio group would
// never render (`v-if="!hasBlocker && needsMainline"` below), and a merge commit's cherry-pick
// could never be confirmed.
const blockers = computed(
  () => preflight.value?.blockers.filter((b) => b.kind !== "mainlineRequired") ?? [],
);
// Every remaining blocker is a real git refusal — unlike `RevertPreflight`'s advisory
// `dirtyWorktree`, there is no route past any of these short of changing the working tree or
// resolving the other operation first, so Confirm stays disabled while any is present.
const hasBlocker = computed(() => blockers.value.length > 0);
const canConfirm = computed(
  () => !hasBlocker.value && (!needsMainline.value || selectedMainline.value !== undefined),
);

function cancel(): void {
  props.ops.resolveCherryPickDialog(null);
}

function confirm(): void {
  if (!canConfirm.value) return;
  props.ops.resolveCherryPickDialog({
    mainline: selectedMainline.value,
    noCommit: noCommit.value,
  });
}
</script>

<template>
  <div v-if="active" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-cherry-pick-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-cherry-pick-dialog-title" class="kv-modal-title">Cherry-pick</h2>
      <p>
        Applies this commit's changes here as a new commit — the original stays where it is.
      </p>

      <p v-if="preflight?.detachedHead" class="kv-modal-note">
        HEAD is detached: the new commit will not belong to any branch until you create one.
      </p>

      <p v-if="preflight?.alreadyApplied" class="kv-modal-note">
        This change already appears in this branch's history; the pick will probably be empty.
      </p>

      <template v-if="hasBlocker">
        <div v-for="(blocker, i) in blockers" :key="i" class="kv-cherry-pick-blocker">
          <template v-if="blocker.kind === 'inProgressOperation'">
            <p>An operation is already in progress. Resolve or abort it first.</p>
          </template>
          <template v-else-if="blocker.kind === 'stagedChanges'">
            <p>Staged changes would be overwritten by this pick — commit or unstage them first:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in blocker.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
          </template>
          <template v-else-if="blocker.kind === 'localChangesWouldBeOverwritten'">
            <p>These local changes would be overwritten by this pick:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in blocker.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
          </template>
          <template v-else-if="blocker.kind === 'untrackedWouldBeOverwritten'">
            <p>These untracked files would be overwritten by this pick:</p>
            <ul class="kv-modal-file-list">
              <li v-for="path in blocker.paths" :key="path"><code>{{ path }}</code></li>
            </ul>
          </template>
        </div>
      </template>

      <template v-if="!hasBlocker && needsMainline">
        <p>
          This picks a merge commit — pick which parent's history to treat as the "mainline"
          (probe 8: git cannot guess this for you):
        </p>
        <div
          v-for="entry in preflight?.mainlineRequired"
          :key="entry.parentNumber"
          class="kv-cherry-pick-parent"
        >
          <label>
            <input
              type="radio"
              name="kv-cherry-pick-mainline"
              :value="entry.parentNumber"
              v-model="selectedMainline"
            />
            Parent {{ entry.parentNumber }} — <code>{{ entry.sha.slice(0, 7) }}</code>
            {{ entry.subject }}
          </label>
        </div>
      </template>

      <template v-if="!hasBlocker && (!needsMainline || selectedMainline !== undefined)">
        <div
          v-if="preflight?.prediction.kind === 'clean'"
          class="kv-cherry-pick-prediction kv-cherry-pick-prediction--clean"
        >
          No conflicts predicted.
        </div>
        <div
          v-else-if="preflight?.prediction.kind === 'conflicts'"
          class="kv-cherry-pick-prediction kv-cherry-pick-prediction--conflict"
        >
          <p>This will likely conflict in:</p>
          <ul class="kv-modal-file-list">
            <li v-for="path in preflight.prediction.paths" :key="path"><code>{{ path }}</code></li>
          </ul>
          <label class="kv-cherry-pick-no-commit">
            <input type="checkbox" v-model="noCommit" />
            Stop before committing (<code>--no-commit</code>), so I can resolve first
          </label>
        </div>
        <div v-else-if="preflight?.prediction.kind === 'unknown'" class="kv-cherry-pick-prediction">
          Couldn't predict the outcome: {{ preflight.prediction.reason }}
        </div>
      </template>

      <div class="kv-modal-actions">
        <button
          type="button"
          class="kv-modal-button kv-modal-button--primary"
          :disabled="!canConfirm"
          data-testid="cherry-pick-confirm"
          @click="confirm"
        >
          Cherry-pick
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style>
.kv-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--kv-overlay-bg);
}

.kv-modal {
  width: min(480px, 90vw);
  max-height: 80vh;
  overflow-y: auto;
  padding: var(--kv-space-4);
  background-color: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 4px 16px var(--kv-widget-shadow);
}

.kv-modal-title {
  margin: 0 0 var(--kv-space-3);
  font-size: 1.05em;
}

.kv-modal-file-list {
  max-height: 160px;
  overflow-y: auto;
  margin: var(--kv-space-2) 0;
  padding-left: var(--kv-space-4);
  font-family: var(--kv-mono-font-family);
  font-size: 0.9em;
}

.kv-modal-note {
  color: var(--kv-diff-deleted-fg);
}

.kv-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--kv-space-2);
  margin-top: var(--kv-space-3);
}

.kv-modal-button {
  padding: var(--kv-space-1) var(--kv-space-3);
  background: transparent;
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  cursor: pointer;
}

.kv-modal-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-modal-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.kv-modal-button--primary {
  background: var(--kv-button-bg);
  color: var(--kv-button-fg);
  border-color: var(--kv-button-bg);
}

.kv-modal-button--primary:hover:not(:disabled) {
  background: var(--kv-button-hover-bg);
  border-color: var(--kv-button-hover-bg);
}

.kv-cherry-pick-blocker {
  margin: var(--kv-space-2) 0;
}

.kv-cherry-pick-parent {
  padding: var(--kv-space-1) 0;
}

.kv-cherry-pick-prediction {
  margin: var(--kv-space-3) 0;
}

.kv-cherry-pick-prediction--clean {
  color: var(--kv-diff-added-fg);
}

.kv-cherry-pick-no-commit {
  display: block;
  margin-top: var(--kv-space-2);
}
</style>
