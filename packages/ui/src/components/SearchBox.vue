<script setup lang="ts">
/**
 * `docs/plans/P11.md` W11: §6.2's `Search […]` toolbar slot. One text input, three toggle
 * buttons (case-sensitive / whole-word / regex) as `aria-pressed` icon buttons with VS Code's
 * own icon-button styling (OQ6: the scope selector lives *inside* the box, not beside it — §6.2
 * gives the toolbar one slot and §6.3's 600px breakpoint has no room for a second control), a
 * Commits/Refs/Both scope `<select>`, the match count, and — when `search.error` is set — an
 * inline message under the box wired to the input via `aria-describedby` so a screen reader
 * hears the compiled-regex error and never a thrown one (probe 4). `SearchResults.vue` (W12) is
 * a sibling this file does not render itself — `App.vue` (W14) positions it under the box and
 * owns the two selection paths, the same division `BranchPicker.vue`/`RowContextMenu.vue`
 * already establish for a trigger and its own popped-open panel.
 *
 * §6.6 keyboard:
 * - `/` and `Ctrl/Cmd+F` focus the input from anywhere in the panel. This file owns that
 *   listener directly — mounted for this component's whole lifetime, which is the app's whole
 *   lifetime (§6.2's slot is never conditionally rendered) — the same way `BranchPicker.vue`
 *   owns its own outside-click listener, rather than routing a third global shortcut through
 *   `App.vue`.
 * - `Enter`/`Shift+Enter` step `SearchState.next()`/`previous()` — commit matches only, never
 *   refs (judgment call 6: a "next match" key that sometimes moves the grid and sometimes moves
 *   a dropdown cursor is a mode, hard part 8).
 * - `Escape` on the input clears the query (`SearchState.clear()`) and asks the parent to move
 *   focus back to the grid (`focusGrid`), but only when there is a query to clear. An empty box
 *   lets the key fall through undisturbed to `App.vue`'s own Esc chain (diff view, then detail
 *   pane) instead of swallowing it — which is this file's local implementation of spec edit 6's
 *   ordering ("an open menu, then the search results dropdown, then the diff view, then the
 *   detail pane") without `App.vue`'s own handler needing to know anything about search at all:
 *   the dropdown is only ever showing when the query is non-empty, so consuming `Escape` exactly
 *   when it is non-empty already *is* "close the dropdown first".
 */
import type { SearchScope } from "@kira-version/core";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ACTION_ICONS } from "../icons/index.ts";
import type { SearchState } from "../state/search.ts";

const props = defineProps<{ search: SearchState }>();
const emit = defineEmits<(e: "focusGrid") => void>();

const inputEl = ref<HTMLInputElement | null>(null);

const ERROR_ID = "kv-search-error";

/** The inline `n of N` indicator mirrors exactly what `Enter`/`Shift+Enter` step through —
 *  commit matches (judgment call 6) — so it is hidden entirely in `Refs` scope, where there is
 *  nothing to page through at all; `SearchResults.vue`'s own group counts (W12) are what show a
 *  ref-hit count, in both `Refs` and `Both` scope alike. */
const countLabel = computed(() => {
  if (props.search.compiled.value.kind !== "ok") return "";
  if (props.search.scope.value === "refs") return "";
  const { n, exact } = props.search.matchCount.value;
  if (n === 0) return "No matches";
  const position = props.search.activeIndex.value >= 0 ? props.search.activeIndex.value + 1 : 1;
  return `${position} of ${n}${exact ? "" : "+"}`;
});

function onInput(event: Event): void {
  props.search.text.value = (event.target as HTMLInputElement).value;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) props.search.previous();
    else props.search.next();
    return;
  }
  if (event.key === "Escape") {
    if (props.search.text.value === "") return; // fall through to App.vue's own Esc chain
    event.preventDefault();
    event.stopPropagation();
    props.search.clear();
    emit("focusGrid");
  }
}

function onScopeChange(event: Event): void {
  props.search.scope.value = (event.target as HTMLSelectElement).value as SearchScope;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target === inputEl.value) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** `Ctrl/Cmd+F` always wins, even while focus sits in some other text field — it is a
 *  deliberate combo, and `preventDefault` is what suppresses the browser's own find-in-page in
 *  its place. Bare `/` only wins when focus is not already inside some *other* editable control,
 *  so typing a literal `/` in the branch-filter box or a rename input is never hijacked. */
function onGlobalKeydown(event: KeyboardEvent): void {
  const isFindCombo = (event.key === "f" || event.key === "F") && (event.ctrlKey || event.metaKey);
  if (event.key !== "/" && !isFindCombo) return;
  if (event.key === "/" && isEditableTarget(event.target)) return;
  event.preventDefault();
  inputEl.value?.focus();
  inputEl.value?.select();
}

onMounted(() => document.addEventListener("keydown", onGlobalKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onGlobalKeydown));

defineExpose({ focus: () => inputEl.value?.focus() });
</script>

<template>
  <div class="kv-search-box">
    <span class="codicon" :class="ACTION_ICONS.search" aria-hidden="true"></span>
    <input
      ref="inputEl"
      type="text"
      class="kv-search-input"
      placeholder="Search"
      aria-label="Search"
      data-testid="search-input"
      :aria-describedby="search.error.value ? ERROR_ID : undefined"
      :aria-invalid="search.error.value ? 'true' : undefined"
      :value="search.text.value"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div class="kv-search-toggles" role="group" aria-label="Search options">
      <button
        type="button"
        class="kv-search-toggle"
        :aria-pressed="search.caseSensitive.value"
        title="Match case"
        aria-label="Match case"
        data-testid="search-toggle-case"
        @click="search.caseSensitive.value = !search.caseSensitive.value"
      >
        <span class="codicon codicon-case-sensitive" aria-hidden="true"></span>
      </button>
      <button
        type="button"
        class="kv-search-toggle"
        :aria-pressed="search.wholeWord.value"
        title="Match whole word"
        aria-label="Match whole word"
        data-testid="search-toggle-whole-word"
        @click="search.wholeWord.value = !search.wholeWord.value"
      >
        <span class="codicon codicon-whole-word" aria-hidden="true"></span>
      </button>
      <button
        type="button"
        class="kv-search-toggle"
        :aria-pressed="search.regex.value"
        title="Use regular expression"
        aria-label="Use regular expression"
        data-testid="search-toggle-regex"
        @click="search.regex.value = !search.regex.value"
      >
        <span class="codicon codicon-regex" aria-hidden="true"></span>
      </button>
    </div>
    <select
      class="kv-search-scope"
      aria-label="Search scope"
      data-testid="search-scope"
      :value="search.scope.value"
      @change="onScopeChange"
    >
      <option value="both">Both</option>
      <option value="commits">Commits</option>
      <option value="refs">Refs</option>
    </select>
    <span v-if="countLabel" class="kv-search-count" data-testid="search-count">{{ countLabel }}</span>
  </div>
  <div v-if="search.error.value" :id="ERROR_ID" class="kv-search-error" role="alert" data-testid="search-error">
    {{ search.error.value }}
  </div>
</template>

<style>
.kv-search-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-1);
  height: 22px;
  padding: 0 var(--kv-space-2);
  background: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
}

.kv-search-box:focus-within {
  border-color: var(--kv-focus-border);
}

.kv-search-input {
  width: 160px;
  background: transparent;
  color: var(--kv-app-fg);
  border: none;
  font-family: inherit;
  font-size: inherit;
}

.kv-search-input:focus {
  outline: none;
}

.kv-search-toggles {
  display: flex;
  gap: 1px;
}

.kv-search-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  background: transparent;
  color: var(--kv-description-fg);
  border: none;
  border-radius: var(--kv-radius);
  cursor: pointer;
}

.kv-search-toggle:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-search-toggle[aria-pressed="true"] {
  background-color: var(--kv-row-selected-bg);
  color: var(--kv-row-selected-fg);
}

.kv-search-scope {
  height: 18px;
  background: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  font-family: inherit;
  font-size: 0.85em;
}

.kv-search-count {
  padding: 0 var(--kv-space-1);
  color: var(--kv-description-fg);
  font-size: 0.85em;
  white-space: nowrap;
}

.kv-search-error {
  position: absolute;
  top: calc(var(--kv-toolbar-height) + 2px);
  z-index: 20;
  padding: var(--kv-space-1) var(--kv-space-2);
  background-color: var(--kv-panel-bg);
  color: var(--kv-error-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 2px 8px var(--kv-widget-shadow);
  font-size: 0.85em;
}
</style>
