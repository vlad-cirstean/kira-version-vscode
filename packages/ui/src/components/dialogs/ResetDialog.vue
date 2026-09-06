<script setup lang="ts">
/**
 * `docs/plans/P10.md` W11: §7.7's confirm step — and, unlike every other dialog in this
 * directory, the confirm step for EVERY reset, not only a hazardous one (judgment call 18:
 * the row menu's "Reset to this commit…" is §7.7's one entry point, and choosing a mode IS the
 * confirmation here — there is no "clean, skip the dialog" fast path to mirror `CheckoutDialog`/
 * `RevertDialog`'s own).
 *
 * OQ11: switching the mode radio never re-requests `preflight.reset` — `OpsState.previewResetMode`
 * recomputes `destroys`/`requiresTypedConfirmation`/`routes`/`verdict` client-side via `core`'s own
 * `classifyReset`, holding `leaving`/`gaining`/`dirty` fixed (they do not depend on `mode` at all).
 */
import type { ResetMode } from "@kira-version/ipc";
import { computed, ref, watch } from "vue";
import type { OpsState } from "../../state/ops.ts";
import { useModalFocus } from "./modalFocus.ts";

const props = defineProps<{ ops: OpsState }>();

const preflight = computed(() => props.ops.pendingReset.value);
const active = computed(() => preflight.value !== undefined);
const rootEl = ref<HTMLDivElement | null>(null);
const { onKeydown } = useModalFocus(active, rootEl);

const typedToken = ref("");
const stashFirst = ref(false);

// A genuinely new target resets the typed confirmation and the stash-first choice; a mode-radio
// change (`previewResetMode`'s own re-classify, same target) must not, or picking a mode would
// immediately blank out what was already typed.
watch(
  () => preflight.value?.target,
  () => {
    typedToken.value = "";
    stashFirst.value = false;
  },
);

const mode = computed<ResetMode>(() => preflight.value?.mode ?? "mixed");

function selectMode(next: ResetMode): void {
  props.ops.previewResetMode(next);
}

const shortTarget = computed(() => preflight.value?.target.slice(0, 7) ?? "");
const shortCurrentHead = computed(() => preflight.value?.currentHead.slice(0, 7) ?? "");
const destroys = computed(() => preflight.value?.destroys ?? []);
const requiresToken = computed(() => preflight.value?.requiresTypedConfirmation ?? false);
const canStashFirst = computed(() => (preflight.value?.routes ?? []).includes("stashFirst"));
const tokenMatches = computed(
  () => !requiresToken.value || typedToken.value.trim() === shortTarget.value,
);
const canConfirm = computed(() => stashFirst.value || tokenMatches.value);

function cancel(): void {
  props.ops.resolveResetDialog(null);
}

function confirm(): void {
  if (!canConfirm.value) return;
  props.ops.resolveResetDialog({
    mode: mode.value,
    stashFirst: stashFirst.value,
    token: requiresToken.value && !stashFirst.value ? typedToken.value.trim() : undefined,
  });
}
</script>

<template>
  <div v-if="active && preflight" class="kv-modal-backdrop">
    <div
      ref="rootEl"
      class="kv-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kv-reset-dialog-title"
      @keydown="onKeydown"
      @keydown.escape="cancel"
    >
      <h2 id="kv-reset-dialog-title" class="kv-modal-title">
        <template v-if="preflight.branch">Move <code>{{ preflight.branch }}</code> to</template>
        <template v-else>Move HEAD to</template>
        <code>{{ shortTarget }}</code>
        <template v-if="preflight.targetSubject">— {{ preflight.targetSubject }}</template>
      </h2>

      <p v-if="!preflight.branch" class="kv-modal-note">
        You are not on a branch, so no branch is changed — this moves HEAD only.
      </p>

      <p v-if="preflight.leaving === 0 && preflight.gaining === 0">
        HEAD is already here — this resets your working state only.
      </p>
      <template v-else-if="preflight.gaining === 0">
        <p>
          {{ preflight.leaving }} commit{{ preflight.leaving === 1 ? "" : "s" }} will leave
          <template v-if="preflight.branch"><code>{{ preflight.branch }}</code></template>
          <template v-else>HEAD</template>:
        </p>
        <ul class="kv-modal-file-list">
          <li v-for="c in preflight.leavingCommits" :key="c.sha">
            <code>{{ c.sha.slice(0, 7) }}</code> {{ c.subject }}
          </li>
        </ul>
        <p v-if="preflight.leavingTruncated" class="kv-reset-more">and more…</p>
      </template>
      <p v-else>
        This moves to a different line of history: {{ preflight.leaving }} commit{{
          preflight.leaving === 1 ? "" : "s"
        }}
        leave, {{ preflight.gaining }} arrive.
      </p>

      <fieldset class="kv-reset-mode-picker">
        <legend>Mode</legend>
        <label class="kv-reset-mode-option">
          <input
            type="radio"
            name="kv-reset-mode"
            value="soft"
            :checked="mode === 'soft'"
            @change="selectMode('soft')"
          />
          <span>
            <strong>Soft</strong> — Branch pointer moves. Index and working tree untouched; the
            difference appears as staged changes. Nothing is lost.
          </span>
        </label>
        <label class="kv-reset-mode-option">
          <input
            type="radio"
            name="kv-reset-mode"
            value="mixed"
            :checked="mode === 'mixed'"
            @change="selectMode('mixed')"
          />
          <span>
            <strong>Mixed</strong> — Branch pointer moves, index reset. Changes appear unstaged.
            Working tree files untouched. Nothing is lost.
          </span>
        </label>
        <label class="kv-reset-mode-option">
          <input
            type="radio"
            name="kv-reset-mode"
            value="hard"
            :checked="mode === 'hard'"
            @change="selectMode('hard')"
          />
          <span>
            <strong>Hard</strong> — Branch pointer, index, <strong>and working tree</strong>
            reset. <strong>Uncommitted changes are destroyed and are not recoverable.</strong>
            Commits left behind remain in the reflog for about 90 days.
          </span>
        </label>
      </fieldset>

      <template v-if="mode === 'hard' && destroys.length > 0">
        <p class="kv-modal-note">This will permanently discard these uncommitted changes:</p>
        <ul class="kv-modal-file-list">
          <li v-for="path in destroys" :key="path"><code>{{ path }}</code></li>
        </ul>
        <p class="kv-reset-untracked-note">
          Untracked and ignored files are <strong>not</strong> affected.
        </p>

        <label v-if="canStashFirst" class="kv-reset-stash-first">
          <input type="checkbox" v-model="stashFirst" />
          Stash these changes first instead of discarding them
        </label>

        <template v-if="!stashFirst">
          <label class="kv-reset-field">
            Type <code>{{ shortTarget }}</code> to confirm
            <input
              v-model="typedToken"
              type="text"
              autofocus
              data-testid="reset-confirm-token"
            />
          </label>
        </template>
      </template>

      <div class="kv-modal-actions">
        <button
          v-if="mode === 'hard' && destroys.length > 0 && canStashFirst"
          type="button"
          class="kv-modal-button kv-modal-button--primary"
          :disabled="!canConfirm"
          data-testid="reset-confirm"
          @click="confirm"
        >
          {{ stashFirst ? "Stash and reset" : "Reset (discard changes)" }}
        </button>
        <button
          v-else
          type="button"
          :class="[
            'kv-modal-button',
            mode === 'hard' && destroys.length > 0
              ? 'kv-modal-button--danger'
              : 'kv-modal-button--primary',
          ]"
          :disabled="!canConfirm"
          data-testid="reset-confirm"
          @click="confirm"
        >
          Reset
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
  width: min(560px, 90vw);
  max-height: 85vh;
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

.kv-modal-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-modal-button:disabled {
  opacity: 0.6;
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

.kv-modal-button--danger {
  border-color: var(--kv-diff-deleted-fg);
  color: var(--kv-diff-deleted-fg);
}

.kv-reset-more {
  color: var(--kv-description-fg);
  font-style: italic;
}

.kv-reset-mode-picker {
  margin: var(--kv-space-3) 0;
  padding: var(--kv-space-2);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
}

.kv-reset-mode-picker legend {
  padding: 0 var(--kv-space-1);
  color: var(--kv-description-fg);
}

.kv-reset-mode-option {
  display: flex;
  gap: var(--kv-space-2);
  align-items: flex-start;
  padding: var(--kv-space-2) 0;
}

.kv-reset-mode-option input {
  margin-top: 0.2em;
}

.kv-reset-untracked-note {
  color: var(--kv-description-fg);
  font-style: italic;
}

.kv-reset-stash-first {
  display: block;
  margin: var(--kv-space-2) 0;
}

.kv-reset-field {
  display: flex;
  flex-direction: column;
  gap: var(--kv-space-1);
  margin: var(--kv-space-2) 0;
}

.kv-reset-field input[type="text"] {
  padding: var(--kv-space-1) var(--kv-space-2);
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  font-family: inherit;
}
</style>
