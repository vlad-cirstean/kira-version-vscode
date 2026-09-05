<script setup lang="ts">
/**
 * `docs/plans/P6.md` W16: §7.11's "make it impossible to miss" — flagged in this phase's own plan
 * as needing extra care, so this file is deliberately conservative: it reads nothing but
 * `ops.statusSummary.value.inProgress` (the one place `classifyInProgress`'s precedence table
 * already lives, in `core`), and touches no state of its own beyond which of its three actions is
 * mid-request.
 *
 * Persistent, above the graph, present for exactly as long as `inProgress !== null` — reactive
 * through `OpsState.refreshStatus`'s own `repo.changed` subscription (W12), which is what makes
 * "Continue re-enables without a manual refresh once the last conflict is staged" true: the
 * watcher already fires on an `index` touch (`git add` is exactly that), `refreshStatus` re-reads
 * `unmergedCount`, and this component is a plain `computed` over the result — there is nothing
 * here to explicitly "recheck".
 *
 * `role="status"`, not `role="alert"` (W20's own reasoning, restated here since it is easy to get
 * backwards): `alert` is for a message that appears and is gone: an assertive region that *stays
 * on screen* for the length of an entire git operation is a screen-reader trap, re-announcing
 * itself on every incidental change unless the AT's own heuristics happen to suppress it. `status`
 * still announces on appearance (the whole point) without demanding attention indefinitely.
 */
import { describeInProgress } from "@kira-version/core";
import { computed, ref } from "vue";
import type { OpsState } from "../state/ops.ts";

const props = defineProps<{
  ops: OpsState;
  resolveConflictEnabled: boolean;
  resolveConflict: (path: string) => Promise<void>;
}>();

const inProgress = computed(() => props.ops.statusSummary.value?.inProgress ?? null);
const busyAction = ref<"resolve" | "continue" | "abort" | undefined>(undefined);

const CONTINUE_REASON_ID = "kv-conflict-continue-reason";

async function onResolve(): Promise<void> {
  const op = inProgress.value;
  const path = op?.conflictedPaths[0];
  if (!path || busyAction.value) return;
  busyAction.value = "resolve";
  try {
    await props.resolveConflict(path);
  } finally {
    busyAction.value = undefined;
  }
}

async function onContinue(): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = "continue";
  try {
    await props.ops.continueOp();
  } finally {
    busyAction.value = undefined;
  }
}

async function onAbort(): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = "abort";
  try {
    await props.ops.abortOp();
  } finally {
    busyAction.value = undefined;
  }
}

const PATH_DISPLAY_CAP = 20;
</script>

<template>
  <div v-if="inProgress" class="kv-conflict-banner" role="status" data-testid="conflict-banner">
    <div class="kv-conflict-banner-row">
      <span class="codicon codicon-warning kv-conflict-banner-icon" aria-hidden="true"></span>
      <span class="kv-conflict-banner-title">{{ describeInProgress(inProgress) }}</span>
      <span v-if="inProgress.unmergedCount > 0" class="kv-conflict-banner-count">
        {{ inProgress.unmergedCount }} unresolved {{ inProgress.unmergedCount === 1 ? "file" : "files" }}
      </span>

      <span class="kv-conflict-banner-spacer"></span>

      <button
        v-if="resolveConflictEnabled"
        type="button"
        class="kv-conflict-banner-button"
        :disabled="inProgress.unmergedCount === 0 || busyAction !== undefined"
        @click="onResolve"
      >
        Resolve in VS Code
      </button>
      <button
        v-if="inProgress.canContinue"
        type="button"
        class="kv-conflict-banner-button"
        :disabled="inProgress.unmergedCount > 0 || busyAction !== undefined"
        :aria-describedby="inProgress.unmergedCount > 0 ? CONTINUE_REASON_ID : undefined"
        @click="onContinue"
      >
        Continue
      </button>
      <button
        v-if="inProgress.canAbort"
        type="button"
        class="kv-conflict-banner-button kv-conflict-banner-button--danger"
        :disabled="busyAction !== undefined"
        @click="onAbort"
      >
        Abort
      </button>
    </div>

    <p v-if="inProgress.unmergedCount > 0" :id="CONTINUE_REASON_ID" class="kv-conflict-banner-reason">
      Resolve the remaining {{ inProgress.unmergedCount }}
      {{ inProgress.unmergedCount === 1 ? "file" : "files" }} first, then Continue.
    </p>

    <ul v-if="inProgress.conflictedPaths.length > 0" class="kv-conflict-banner-paths">
      <li v-for="path in inProgress.conflictedPaths.slice(0, PATH_DISPLAY_CAP)" :key="path">
        <code>{{ path }}</code>
      </li>
      <li v-if="inProgress.conflictedPaths.length > PATH_DISPLAY_CAP" class="kv-conflict-banner-more">
        +{{ inProgress.conflictedPaths.length - PATH_DISPLAY_CAP }} more
      </li>
    </ul>
  </div>
</template>

<style>
.kv-conflict-banner {
  flex-shrink: 0;
  padding: var(--kv-space-2) var(--kv-space-3);
  background-color: var(--kv-overlay-bg);
  border-bottom: 1px solid var(--kv-panel-border);
}

.kv-conflict-banner-row {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
}

.kv-conflict-banner-icon {
  color: var(--kv-diff-modified-fg);
}

.kv-conflict-banner-title {
  font-weight: 600;
}

.kv-conflict-banner-count {
  color: var(--kv-description-fg);
  font-size: 0.9em;
}

.kv-conflict-banner-spacer {
  flex: 1;
}

.kv-conflict-banner-button {
  padding: var(--kv-space-1) var(--kv-space-2);
  background: transparent;
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  cursor: pointer;
}

.kv-conflict-banner-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-conflict-banner-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.kv-conflict-banner-button--danger {
  border-color: var(--kv-diff-deleted-fg);
  color: var(--kv-diff-deleted-fg);
}

.kv-conflict-banner-reason {
  margin: var(--kv-space-1) 0 0;
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-conflict-banner-paths {
  margin: var(--kv-space-1) 0 0;
  padding-left: var(--kv-space-4);
  max-height: 80px;
  overflow-y: auto;
  font-family: var(--kv-mono-font-family);
  font-size: 0.85em;
}

.kv-conflict-banner-more {
  color: var(--kv-description-fg);
}
</style>
