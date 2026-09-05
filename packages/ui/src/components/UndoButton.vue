<script setup lang="ts">
/**
 * `docs/plans/P6.md` W17: §7.12's single-level "Undo last operation". Present only while
 * `ops.undoSlot` holds a record (`OpsState.refreshUndo`/`#applyResult` are the only things that
 * ever set it, and both clear it — to `null` — the moment a non-undoable op runs, which is what
 * makes "no non-undoable operation ever renders this" true without this file re-deriving
 * `UNDO_POLICY` itself). Recovery sha is real, copyable text (`clipboardActions.ts`, matching
 * every other sha in this app), never only inside a tooltip.
 */
import type { OpsState } from "../state/ops.ts";

const props = defineProps<{
  ops: OpsState;
  clipboardEnabled: boolean;
  copy: (text: string, whatCopied: string) => void;
}>();

async function undo(): Promise<void> {
  await props.ops.undo();
}
</script>

<template>
  <div v-if="ops.undoSlot.value" class="kv-undo">
    <button
      type="button"
      class="kv-undo-button"
      :title="`${ops.undoSlot.value.label} — one level, does not restore uncommitted work`"
      :disabled="ops.busy.value"
      @click="undo"
    >
      <span class="codicon codicon-discard" aria-hidden="true"></span>
      <span>{{ ops.undoSlot.value.label }}</span>
    </button>
    <button
      v-if="clipboardEnabled"
      type="button"
      class="kv-undo-sha"
      :title="`Copy recovery SHA ${ops.undoSlot.value.recoverySha}`"
      @click="copy(ops.undoSlot.value.recoverySha, 'recovery SHA')"
    >
      {{ ops.undoSlot.value.recoverySha.slice(0, 7) }}
    </button>
    <span v-else class="kv-undo-sha">{{ ops.undoSlot.value.recoverySha.slice(0, 7) }}</span>
  </div>
</template>

<style>
.kv-undo {
  display: flex;
  align-items: center;
  gap: var(--kv-space-1);
}

.kv-undo-button {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-2);
  height: 22px;
  padding: 0 var(--kv-space-2);
  border: none;
  border-radius: var(--kv-radius);
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-undo-button:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-undo-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.kv-undo-sha {
  font-family: var(--kv-mono-font-family);
  font-size: 0.85em;
  color: var(--kv-description-fg);
  background: transparent;
  border: none;
  cursor: copy;
}
</style>
