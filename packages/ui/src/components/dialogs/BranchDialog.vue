<script setup lang="ts">
/**
 * "Create branch here" (W14's row menu). §10's own exit table and W15's own text enumerate only
 * `CheckoutDialog`/`TagDialog`/`RevertDialog` — branch creation has no comparable hazard (git
 * never refuses it, and there is no annotated-tag-style silent-data-loss case to guard), so this
 * file is a judgment call rather than something the plan named directly: the same small
 * name/start-point/checkout-toggle modal `TagDialog.vue` uses for a tag, reusing `core`'s own
 * `validateRefName` prefilter (branch and tag names share the same `check-ref-format --branch`
 * rule, §7.5/§7.9 both cite it).
 */
import { validateRefName } from "@kira-version/core";
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ open: boolean; startPoint: string; ops: OpsState }>();
const emit = defineEmits<(e: "close") => void>();

const name = ref("");
const checkout = ref(true);

const active = computed(() => props.open);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    name.value = "";
    checkout.value = true;
  },
);

const nameError = computed(() => {
  if (name.value === "") return undefined;
  const { valid, error } = validateRefName(name.value);
  return valid ? undefined : error;
});
const canSubmit = computed(() => name.value !== "" && nameError.value === undefined);

function cancel(): void {
  emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  await props.ops.branchCreate({
    name: name.value,
    startPoint: props.startPoint,
    checkout: checkout.value,
    track: undefined,
  });
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
      aria-labelledby="kv-branch-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-branch-dialog-title" class="kv-modal-title">Create branch</h2>
      <p class="kv-modal-note">Starting from <code>{{ startPoint.slice(0, 7) }}</code></p>

      <label class="kv-tag-field">
        Name
        <input type="text" v-model="name" autofocus />
      </label>
      <p v-if="nameError" class="kv-modal-error">{{ nameError }}</p>

      <label class="kv-tag-field kv-tag-field--inline">
        <input type="checkbox" v-model="checkout" />
        Switch to it
      </label>

      <div class="kv-modal-actions">
        <button type="button" class="kv-modal-button kv-modal-button--primary" :disabled="!canSubmit" @click="submit">
          Create branch
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>
