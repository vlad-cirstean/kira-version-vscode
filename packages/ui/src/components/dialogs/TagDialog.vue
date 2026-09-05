<script setup lang="ts">
/**
 * `docs/plans/P6.md` W15: "create tag here" (W14's row menu). Unlike `CheckoutDialog.vue`/
 * `RevertDialog.vue`, this one is not driven by an `OpsState` pending-ref (P6 has no
 * `preflight.tagCreate` endpoint) — `App.vue` opens it directly with the target sha and closes
 * it on `close`; `tagDialogModel.ts` supplies the pure classification either way.
 */
import { computed, ref, watch } from "vue";
import type { RefRow } from "@kira-version/ipc";
import type { OpsState } from "../../state/ops.ts";
import { canSubmitTagCreate, classifyTagName } from "./tagDialogModel.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{
  open: boolean;
  target: string;
  existingTags: readonly RefRow[];
  ops: OpsState;
}>();

const emit = defineEmits<(e: "close") => void>();

const name = ref("");
const annotated = ref(false);
const message = ref("");
const force = ref(false);

const active = computed(() => props.open);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    name.value = "";
    annotated.value = false;
    message.value = "";
    force.value = false;
  },
);

const state = computed(() => classifyTagName(name.value, props.existingTags, force.value));
const canSubmit = computed(() => canSubmitTagCreate(state.value, annotated.value, message.value));

function cancel(): void {
  emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  await props.ops.tagCreate({
    name: name.value,
    target: props.target,
    message: annotated.value ? message.value : undefined,
    force: force.value,
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
      aria-labelledby="kv-tag-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-tag-dialog-title" class="kv-modal-title">Create tag</h2>
      <p class="kv-modal-note">Tagging <code>{{ target.slice(0, 7) }}</code></p>

      <label class="kv-tag-field">
        Name
        <input type="text" v-model="name" autofocus />
      </label>
      <p v-if="state.nameError" class="kv-modal-error">{{ state.nameError }}</p>

      <template v-if="state.verdict === 'blockedByExisting'">
        <p class="kv-modal-error">
          A tag named "{{ name }}" already exists{{ state.existingIsAnnotated ? " (annotated)" : "" }}.
        </p>
        <label class="kv-tag-field kv-tag-field--inline">
          <input type="checkbox" v-model="force" />
          Replace it
        </label>
      </template>

      <template v-if="state.verdict === 'movesWithForce' && state.requiresAnnotationToPreserve">
        <p class="kv-modal-error">
          The existing tag is annotated — moving it without a message here would silently downgrade
          it to lightweight. Supply a message below to keep it annotated.
        </p>
      </template>

      <label class="kv-tag-field kv-tag-field--inline">
        <input type="checkbox" v-model="annotated" />
        Annotated
      </label>
      <label v-if="annotated" class="kv-tag-field">
        Message
        <textarea v-model="message" rows="3"></textarea>
      </label>

      <div class="kv-modal-actions">
        <button type="button" class="kv-modal-button kv-modal-button--primary" :disabled="!canSubmit" @click="submit">
          Create tag
        </button>
        <button type="button" class="kv-modal-button" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style>
.kv-tag-field {
  display: flex;
  flex-direction: column;
  gap: var(--kv-space-1);
  margin: var(--kv-space-2) 0;
}

.kv-tag-field--inline {
  flex-direction: row;
  align-items: center;
}

.kv-tag-field input[type="text"],
.kv-tag-field textarea {
  padding: var(--kv-space-1) var(--kv-space-2);
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  font-family: inherit;
}

.kv-modal-error {
  color: var(--kv-diff-deleted-fg);
  margin: var(--kv-space-1) 0;
}
</style>
