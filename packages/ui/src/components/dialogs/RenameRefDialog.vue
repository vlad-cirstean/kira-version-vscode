<script setup lang="ts">
/**
 * `docs/plans/P7.md` W14: "Rename branch…" from the graph's own ref-badge context menu
 * (`App.vue`'s second `RowContextMenu`). `BranchPicker.vue`'s own rename swaps its dropdown row
 * for an inline text field — there is no comparable row here (the badge is a DOM fragment inside
 * a commit's message cell, not a list item with room to become an input), so this is a small
 * modal instead: `BranchDialog.vue`'s own "no comparable hazard" judgment call (git never
 * refuses a rename the way it can refuse a checkout or a force-move), extended to a rename with
 * a prefilled name field rather than an empty one, validated with the same `validateRefName`
 * prefilter `BranchDialog.vue`/`TagDialog.vue` already use.
 */
import { validateRefName } from "@kira-version/core";
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ open: boolean; currentName: string; ops: OpsState }>();
const emit = defineEmits<(e: "close") => void>();

const name = ref("");

const active = computed(() => props.open);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    name.value = props.currentName;
  },
);

const nameError = computed(() => {
  if (name.value === "" || name.value === props.currentName) return undefined;
  const { valid, error } = validateRefName(name.value);
  return valid ? undefined : error;
});
const canSubmit = computed(
  () => name.value !== "" && name.value !== props.currentName && nameError.value === undefined,
);

function cancel(): void {
  emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  await props.ops.branchRename(props.currentName, name.value);
  emit("close");
}
</script>

<template>
  <div v-if="open" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-rename-ref-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-rename-ref-dialog-title" class="kv-modal-title">Rename branch</h2>
      <p class="kv-modal-note">Renaming <code>{{ currentName }}</code></p>

      <label class="kv-tag-field">
        New name
        <input type="text" v-model="name" autofocus />
      </label>
      <p v-if="nameError" class="kv-modal-error">{{ nameError }}</p>

      <div class="kv-modal-actions">
        <button
          type="button"
          class="kv-modal-button kv-modal-button--primary"
          :disabled="!canSubmit"
          @click="submit"
        >
          Rename branch
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>
