<script setup lang="ts">
/**
 * `docs/plans/P6.md` W15: §7's confirm step, "only when destructive or when pre-flight found a
 * hazard". `OpsState.runCheckout` only ever awaits this dialog for a `"blocked"` verdict (`clean`
 * and `cleanCarry` proceed with no prompt, §7.5 taken literally — see that method's own doc
 * comment) — so this file has nothing to render for either of those and never receives one.
 */
import type { CheckoutPreflight } from "@kira-version/ipc";
import { computed, ref } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ ops: OpsState }>();

const preflight = computed<CheckoutPreflight | undefined>(() => props.ops.pendingCheckout.value);
const active = computed(() => preflight.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

/** W2's own asserted order — inProgress first (it makes every other remedy moot), then worktree,
 *  then untracked, then tracked — so the *headline* blocker is always the one that actually
 *  explains why nothing else here would have helped either. */
const headline = computed(() => {
  const blockers = preflight.value?.blockers ?? [];
  return (
    blockers.find((b) => b.kind === "inProgressOperation") ??
    blockers.find((b) => b.kind === "worktreeConflict") ??
    blockers.find((b) => b.kind === "blockedByUntracked") ??
    blockers.find((b) => b.kind === "blockedByTracked")
  );
});

const trackedBlocker = computed(() =>
  preflight.value?.blockers.find((b) => b.kind === "blockedByTracked"),
);
const canDiscard = computed(() => preflight.value?.routes.includes("discard") ?? false);

function cancel(): void {
  props.ops.resolveCheckoutDialog(null);
}

function discard(): void {
  props.ops.resolveCheckoutDialog({ discardLocalChanges: true });
}
</script>

<template>
  <div v-if="active" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-checkout-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-checkout-dialog-title" class="kv-modal-title">Can't check out {{ preflight?.target.name }}</h2>

      <template v-if="headline?.kind === 'inProgressOperation'">
        <p>An operation is already in progress. Resolve or abort it first.</p>
      </template>

      <template v-else-if="headline?.kind === 'worktreeConflict'">
        <p>
          <code>{{ headline.branch }}</code> is already checked out in another worktree
          (<code>{{ headline.worktreePath }}</code>). Git will not check out the same branch in two
          places at once.
        </p>
      </template>

      <template v-else-if="headline?.kind === 'blockedByUntracked'">
        <p>These untracked files would be overwritten by the checkout:</p>
        <ul class="kv-modal-file-list">
          <li v-for="path in headline.paths" :key="path"><code>{{ path }}</code></li>
        </ul>
        <p>Move or remove them yourself, then try again — there is no safe way to discard them here.</p>
      </template>

      <template v-else-if="trackedBlocker">
        <p>These local changes would be overwritten by the checkout:</p>
        <ul class="kv-modal-file-list">
          <li v-for="path in trackedBlocker.paths" :key="path"><code>{{ path }}</code></li>
        </ul>
        <p v-if="canDiscard" class="kv-modal-note">
          Discard permanently deletes these changes — this cannot be undone. (A future version adds
          stashing them instead.)
        </p>
      </template>

      <div class="kv-modal-actions">
        <button v-if="canDiscard" type="button" class="kv-modal-button kv-modal-button--danger" @click="discard">
          Discard changes and check out
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
  margin-top: var(--kv-space-4);
}

.kv-modal-button {
  padding: var(--kv-space-1) var(--kv-space-3);
  background: transparent;
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  cursor: pointer;
}

.kv-modal-button:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-modal-button--danger {
  border-color: var(--kv-diff-deleted-fg);
  color: var(--kv-diff-deleted-fg);
}
</style>
