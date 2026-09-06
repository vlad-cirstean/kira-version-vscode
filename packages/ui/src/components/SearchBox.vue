<script setup lang="ts">
/**
 * `docs/plans/P11.md` W11/W12: §6.2's `Search […]` toolbar slot. One text input, three toggle
 * buttons (case-sensitive / whole-word / regex) as `aria-pressed` icon buttons with VS Code's own
 * icon-button styling, a Commits/Refs/Both scope `<select>` living *inside* the box (OQ6: §6.2
 * gives the toolbar one slot and §6.3's 600px breakpoint has no room for a second control), the
 * inline `n of N` match count, an inline regex error wired to the input via `aria-describedby`
 * (probe 4) — and, nested inside this same root the way `BranchPicker.vue` nests `TagList.vue`/
 * `StashList.vue` inside its own open panel, `SearchResults.vue`'s grouped dropdown.
 *
 * **Why the dropdown lives here, not as an `App.vue`-positioned sibling.** `SearchResults.vue`
 * follows the ARIA combobox pattern (`role="listbox"` + `aria-activedescendant`), which requires
 * DOM focus to stay on the input the whole time an option is "active" — arrow keys move a virtual
 * cursor, never real focus, so typing and arrowing interleave freely and a mouse click on a row
 * never blurs the box. That means the arrow-key/Enter/Escape handling for the dropdown has to
 * live wherever the input's own `keydown` fires, which is this file; `SearchResults.vue` itself
 * stays a pure renderer over `searchResultsModel.ts`'s fold plus the `highlightedId` this file
 * hands it, emitting only a plain `select`/`hover`/`runBodySearch` this file forwards or acts on.
 *
 * **Reconciling `Enter` with "next match" (hard part 8, judgment call 6).** Two different things
 * both want `Enter`: `§7.8`'s "step through commit matches" and the listbox's own "accept the
 * highlighted option". `#highlightedIndex` is the tie-break: `-1` (nothing arrowed to yet) means
 * `Enter`/`Shift+Enter` step `SearchState.next()`/`previous()` exactly as `§7.8` describes commit
 * matches only, never refs; the moment an arrow key has moved that cursor onto some option,
 * `Enter` accepts *that* option instead (ref or commit alike) and `Shift+Enter` reverts to no-op,
 * since the dropdown has no symmetric "previous option" gesture of its own to give it.
 *
 * **`Escape`'s two-stage order (spec edit 6, OQ5).** OQ5 says closing the dropdown must not erase
 * the in-place highlights — a user closing it to look at the graph is still mid-search. So a
 * first `Escape` while the dropdown is open only dismisses it (`#dropdownDismissed`), leaving the
 * query and every derived highlight untouched; a second `Escape` (or the first, when the dropdown
 * was already closed or never open) clears the query via `SearchState.clear()` and asks the
 * parent to move focus back to the grid (`focusGrid`). An empty box with no dropdown open lets
 * the key fall through undisturbed to `App.vue`'s own Esc chain (diff view, then detail pane) —
 * together this *is* spec edit 6's "an open menu, then the search results dropdown, then the diff
 * view, then the detail pane" without `App.vue`'s own handler needing to know anything about
 * search at all.
 *
 * **`/` and `Ctrl/Cmd+F`** focus the input from anywhere in the panel (§6.6). This file owns that
 * listener directly — mounted for its own whole lifetime, which is the app's whole lifetime
 * (§6.2's slot is never conditionally rendered) — the same way `BranchPicker.vue` owns its own
 * outside-click listener, rather than routing a third global shortcut through `App.vue`.
 */
import type { SearchScope } from "@kira-version/core";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ACTION_ICONS } from "../icons/index.ts";
import type { SearchState } from "../state/search.ts";
import { MIN_TAIL_QUERY_LENGTH } from "../state/search.ts";
import SearchResults from "./SearchResults.vue";
import type { SearchOption } from "./searchResultsModel.ts";
import { buildSearchResultsModel } from "./searchResultsModel.ts";

const props = defineProps<{ search: SearchState }>();
const emit = defineEmits<{
  (e: "focusGrid"): void;
  (e: "select", option: SearchOption): void;
}>();

const rootEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const ERROR_ID = "kv-search-error";

/** The inline `n of N` indicator mirrors exactly what `Enter`/`Shift+Enter` step through —
 *  commit matches (judgment call 6) — so it is hidden entirely in `Refs` scope, where there is
 *  nothing to page through at all; `SearchResults.vue`'s own group counts are what show a
 *  ref-hit count, in both `Refs` and `Both` scope alike. */
const countLabel = computed(() => {
  if (props.search.compiled.value.kind !== "ok") return "";
  if (props.search.scope.value === "refs") return "";
  const { n, exact } = props.search.matchCount.value;
  if (n === 0) return "No matches";
  const position = props.search.activeIndex.value >= 0 ? props.search.activeIndex.value + 1 : 1;
  return `${position} of ${n}${exact ? "" : "+"}`;
});

// ---------------------------------------------------------------------------------------
// The dropdown: visible whenever the query compiles to something real, dismissible without
// touching the query (OQ5), reopened by the next keystroke.
// ---------------------------------------------------------------------------------------
const dropdownDismissed = ref(false);
const highlightedIndex = ref(-1);

const resultsModel = computed(() =>
  buildSearchResultsModel({
    scope: props.search.scope.value,
    refHits: props.search.refHits.value,
    commitHits: props.search.commitHits.value,
    loaded: props.search.loaded.value,
    loadedRowCount: props.search.loadedRowCount.value,
    tail: props.search.tail.value,
  }),
);

const dropdownVisible = computed(
  () => props.search.compiled.value.kind === "ok" && !dropdownDismissed.value,
);

const highlightedOption = computed<SearchOption | undefined>(
  () => resultsModel.value.flatOptions[highlightedIndex.value],
);

/** OQ1's on-demand override, shown only when that is the *actual* reason the tail has not run —
 *  never for a too-short query or `Refs` scope, where offering it would be a lie about what it
 *  does. */
const showBodySearchAffordance = computed(
  () =>
    props.search.compiled.value.kind === "ok" &&
    props.search.scope.value !== "refs" &&
    props.search.text.value.length >= MIN_TAIL_QUERY_LENGTH &&
    props.search.tail.value === undefined &&
    props.search.tailSkippedByExhaustion.value,
);

// Typing (or a toggle/scope change producing a new query) always reopens a dismissed dropdown
// and drops whatever option an earlier query's arrow-key nav had reached — that cursor no longer
// refers to anything meaningful once the option list has been rebuilt.
watch(
  () => props.search.compiled.value,
  () => {
    dropdownDismissed.value = false;
    highlightedIndex.value = -1;
  },
);

function onInput(event: Event): void {
  props.search.text.value = (event.target as HTMLInputElement).value;
}

function selectOption(option: SearchOption): void {
  dropdownDismissed.value = true;
  emit("select", option);
}

function onKeydown(event: KeyboardEvent): void {
  const flat = resultsModel.value.flatOptions;
  if (event.key === "ArrowDown" && dropdownVisible.value && flat.length > 0) {
    event.preventDefault();
    highlightedIndex.value = (highlightedIndex.value + 1) % flat.length;
    return;
  }
  if (event.key === "ArrowUp" && dropdownVisible.value && flat.length > 0) {
    event.preventDefault();
    highlightedIndex.value = (highlightedIndex.value - 1 + flat.length) % flat.length;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const option = highlightedOption.value;
    if (option !== undefined) {
      selectOption(option);
    } else if (event.shiftKey) {
      props.search.previous();
    } else {
      props.search.next();
    }
    return;
  }
  if (event.key === "Escape") {
    if (dropdownVisible.value) {
      event.preventDefault();
      event.stopPropagation();
      dropdownDismissed.value = true;
      return;
    }
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

function onDocumentPointerDown(event: PointerEvent): void {
  if (!dropdownVisible.value) return;
  if (rootEl.value && event.target instanceof Node && rootEl.value.contains(event.target)) return;
  dropdownDismissed.value = true;
}

watch(dropdownVisible, (visible) => {
  if (visible) document.addEventListener("pointerdown", onDocumentPointerDown);
  else document.removeEventListener("pointerdown", onDocumentPointerDown);
});

// ---------------------------------------------------------------------------------------
// §6.6's `/` and `Ctrl/Cmd+F`
// ---------------------------------------------------------------------------------------
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
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("pointerdown", onDocumentPointerDown);
});

defineExpose({ focus: () => inputEl.value?.focus() });
</script>

<template>
  <div ref="rootEl" class="kv-search-box-root">
    <div class="kv-search-box">
      <span class="codicon" :class="ACTION_ICONS.search" aria-hidden="true"></span>
      <input
        ref="inputEl"
        type="text"
        class="kv-search-input"
        placeholder="Search"
        aria-label="Search"
        role="combobox"
        aria-haspopup="listbox"
        data-testid="search-input"
        :aria-expanded="dropdownVisible && resultsModel.sections.length > 0"
        :aria-activedescendant="highlightedOption?.id"
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
    <SearchResults
      v-if="dropdownVisible"
      :model="resultsModel"
      :highlighted-id="highlightedOption?.id"
      :searching="search.searching.value"
      :tail-stale="search.tailStale.value"
      :show-body-search-affordance="showBodySearchAffordance"
      @select="selectOption"
      @hover="(option) => (highlightedIndex = resultsModel.flatOptions.indexOf(option))"
      @run-body-search="search.runBodySearch()"
    />
  </div>
</template>

<style>
.kv-search-box-root {
  position: relative;
}

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
  top: calc(100% + 2px);
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
