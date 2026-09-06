<script setup lang="ts">
/**
 * `docs/plans/P8.md` W17: the confirm step for `OpsState.runForcePush` — mirrors
 * `CheckoutDialog.vue`/`RevertDialog.vue`'s own "a hazard pre-flight sets a pending ref, this
 * dialog renders while it is set, resolving it settles the promise the caller is awaiting"
 * shape, `pendingForcePush`/`resolveForcePushDialog` playing the same roles as
 * `pendingCheckout`/`resolveCheckoutDialog`.
 *
 * Two escalating confirmations, per §7.4/D48/D52:
 *  - The default path is the lease (`--force-with-lease --force-if-includes`) — safe against
 *    anything pushed since `remoteTip` was read, whether or not this session ever fetched it.
 *    On a protected branch (`preflight.protectedBy` non-null) it additionally requires typing
 *    the branch name back, D52's own friction for the common protected case.
 *  - Plain `--force` bypasses the lease entirely and is behind its own, separately-worded
 *    confirmation (a `<details>` disclosure, collapsed by default) — needed on top of, not
 *    instead of, the typed branch name when the branch is also protected.
 */
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ ops: OpsState }>();

const pending = computed(() => props.ops.pendingForcePush.value);
const active = computed(() => pending.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

const typedBranch = ref("");
const understandPlain = ref(false);

watch(pending, () => {
  typedBranch.value = "";
  understandPlain.value = false;
});

const protectedBy = computed(() => pending.value?.preflight.protectedBy ?? null);
const isProtected = computed(() => protectedBy.value !== null);
const confirmToken = computed(() => (isProtected.value ? typedBranch.value : undefined));
const branchNameMatches = computed(
  () => !isProtected.value || typedBranch.value === pending.value?.branch,
);
const canConfirmLease = computed(() => branchNameMatches.value);
const canConfirmPlain = computed(() => branchNameMatches.value && understandPlain.value);

function shortSha(sha: string | null): string {
  return sha === null ? "nothing yet" : sha.slice(0, 7);
}

function cancel(): void {
  props.ops.resolveForcePushDialog(null);
}

function confirmLease(): void {
  if (!canConfirmLease.value) return;
  props.ops.resolveForcePushDialog({ plain: false, confirmToken: confirmToken.value });
}

function confirmPlain(): void {
  if (!canConfirmPlain.value) return;
  props.ops.resolveForcePushDialog({ plain: true, confirmToken: confirmToken.value });
}
</script>

<template>
  <div v-if="active && pending" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-force-push-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-force-push-dialog-title" class="kv-modal-title">
        Force push {{ pending.branch }} to {{ pending.remote }}?
      </h2>

      <p>
        This will overwrite <code>{{ pending.remote }}/{{ pending.branch }}</code>, currently at
        <code>{{ shortSha(pending.preflight.remoteTip) }}</code>.
        <template v-if="pending.preflight.behind > 0">
          It is {{ pending.preflight.behind }} commit{{ pending.preflight.behind === 1 ? "" : "s" }}
          ahead of what you last saw.
        </template>
      </p>

      <p v-if="protectedBy" class="kv-modal-error">
        <code>{{ pending.branch }}</code> matches your protected pattern
        <code>{{ protectedBy }}</code>. Type the branch name to confirm.
      </p>
      <label v-if="protectedBy" class="kv-force-push-field">
        Branch name
        <input
          v-model="typedBranch"
          type="text"
          autofocus
          :placeholder="pending.branch"
          data-testid="force-push-confirm-branch"
        />
      </label>

      <div class="kv-modal-actions">
        <button
          type="button"
          class="kv-modal-button kv-modal-button--primary"
          :disabled="!canConfirmLease"
          data-testid="force-push-confirm-lease"
          @click="confirmLease"
        >
          Force push (with lease)
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>

      <details class="kv-force-push-plain">
        <summary>Use plain <code>--force</code> instead</summary>
        <p class="kv-modal-error">
          This skips the lease check entirely — it will overwrite the remote branch even if
          someone else has pushed to it since the lease's own tip was read, with no protection
          against discarding their work.
        </p>
        <label class="kv-force-push-field kv-force-push-field--inline">
          <input v-model="understandPlain" type="checkbox" data-testid="force-push-plain-ack" />
          I understand — overwrite the remote branch without checking for other pushes
        </label>
        <div class="kv-modal-actions">
          <button
            type="button"
            class="kv-modal-button kv-modal-button--danger"
            :disabled="!canConfirmPlain"
            data-testid="force-push-confirm-plain"
            @click="confirmPlain"
          >
            Force push (plain --force)
          </button>
        </div>
      </details>
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

.kv-modal-error {
  color: var(--kv-diff-deleted-fg);
  margin: var(--kv-space-1) 0;
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
  opacity: 0.6;
  cursor: default;
}

/* `--kv-button-bg`/`--kv-button-fg` are the tokens this app already uses for a real, dedicated
   filled-button pair (`RevertDialog.vue`'s own "Revert" button) — reused here rather than
   inventing a third. */
.kv-modal-button--primary {
  background: var(--kv-button-bg);
  color: var(--kv-button-fg);
  border-color: var(--kv-button-bg);
}

.kv-modal-button--primary:hover:not(:disabled) {
  background: var(--kv-button-hover-bg);
  border-color: var(--kv-button-hover-bg);
}

.kv-modal-button--danger {
  border-color: var(--kv-diff-deleted-fg);
  color: var(--kv-diff-deleted-fg);
}

.kv-force-push-field {
  display: flex;
  flex-direction: column;
  gap: var(--kv-space-1);
  margin: var(--kv-space-2) 0;
}

.kv-force-push-field--inline {
  flex-direction: row;
  align-items: center;
}

.kv-force-push-field input[type="text"] {
  padding: var(--kv-space-1) var(--kv-space-2);
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  font-family: inherit;
}

.kv-force-push-plain {
  margin-top: var(--kv-space-3);
  padding-top: var(--kv-space-2);
  border-top: 1px solid var(--kv-panel-border);
}

.kv-force-push-plain summary {
  cursor: pointer;
  color: var(--kv-description-fg);
}
</style>
