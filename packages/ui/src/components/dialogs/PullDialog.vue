<script setup lang="ts">
/**
 * `docs/plans/P9.md` §7.3/§7.5's `stashAndCarry` route, pull's side (OQ10/W10) — the confirm step
 * for `OpsState.runPull`'s own `dirtyNonFastForward` blocker, mirroring `CheckoutDialog.vue`'s
 * "a hazard pre-flight sets a pending ref, this dialog renders while it is set, resolving it
 * settles the promise the caller is awaiting" shape exactly, one route simpler: pull's own
 * `PullPreflight.routes` only ever offers `"stashAndCarry"` (there is no pull analogue of
 * "discard" — a merge/rebase cannot be told to just throw the local changes away), so
 * `resolvePullDialog` takes a plain `boolean` rather than a tagged route.
 */
import type { PullPreflight } from "@kira-version/ipc";
import { computed, ref } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ ops: OpsState }>();

const pending = computed<PullPreflight | undefined>(() => props.ops.pendingPull.value);
const active = computed(() => pending.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

function cancel(): void {
  props.ops.resolvePullDialog(false);
}

function stashAndCarry(): void {
  props.ops.resolvePullDialog(true);
}
</script>

<template>
  <div v-if="active && pending" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-pull-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-pull-dialog-title" class="kv-modal-title">Can't pull — local changes in the way</h2>
      <p>
        Pulling with <code>{{ pending.strategy }}</code> would rewrite history here, and your
        working tree has uncommitted changes that would be overwritten.
      </p>
      <p class="kv-modal-note">
        Stashing them first keeps them safe: your changes are pushed to a stash, the pull runs,
        then — if it can be applied back with no conflict — they are popped back automatically. A
        predicted conflict leaves them stashed instead of forcing a bad pop; nothing is ever
        discarded.
      </p>

      <div class="kv-modal-actions">
        <button
          type="button"
          class="kv-modal-button kv-modal-button--primary"
          data-testid="pull-stash-and-carry"
          @click="stashAndCarry"
        >
          Stash changes and pull
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>

<!-- No `<style>` block: every class this template uses (`.kv-modal-*`) is already declared,
     unscoped, by `CheckoutDialog.vue`/`ForcePushDialog.vue` — `App.vue` always mounts all of them
     alongside this file, matching `StashDialog.vue`'s own precedent. -->
