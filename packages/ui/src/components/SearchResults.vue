<script lang="ts">
/** `SearchBox.vue`'s own `aria-controls` names this id (P11 W20 a11y pass) — the combobox
 *  pattern's own required-attribute, missing until then. A stable export rather than two files
 *  independently agreeing on the same string literal. `<script setup>` cannot itself carry a
 *  named export, so this one constant lives in a plain sibling `<script>` block instead. */
export const SEARCH_LISTBOX_ID = "kv-search-listbox";
</script>

<script setup lang="ts">
/**
 * `docs/plans/P11.md` W12: the grouped dropdown `SearchBox.vue` renders inside its own panel
 * (the same nesting `BranchPicker.vue` uses for `TagList.vue`/`StashList.vue`) — refs first
 * (local / remote / tag subsections, each labelled), then commits, each hit showing its kind and,
 * when it matched somewhere other than the subject or ref name, a field label. `role="listbox"`
 * with `aria-activedescendant` set on the *input* (`SearchBox.vue`'s own, per the ARIA combobox
 * pattern — this file never moves DOM focus onto a row), so option elements here carry no
 * `tabindex` of their own and clicking one never blurs the input; `searchResultsModel.ts` owns
 * every grouping/ordering/cap decision, this file only renders it.
 *
 * Keyboard (arrow-key nav, `Enter` to select, `Escape` to close) lives in `SearchBox.vue` — the
 * element that actually holds focus throughout — not here; this file only reflects
 * `highlightedId` back as `aria-selected` and forwards a click as `select`.
 */
import { computed } from "vue";
import { formatRelativeDate } from "./dateFormat.ts";
import type { SearchOption, SearchResultsModel } from "./searchResultsModel.ts";
import { fieldLabel } from "./searchResultsModel.ts";

const props = defineProps<{
  model: SearchResultsModel;
  highlightedId: string | undefined;
  searching: boolean;
  tailStale: boolean;
  showBodySearchAffordance: boolean;
}>();

const emit = defineEmits<{
  (e: "select", option: SearchOption): void;
  (e: "hover", option: SearchOption): void;
  (e: "runBodySearch"): void;
}>();

const isEmpty = computed(() => props.model.sections.length === 0);
</script>

<template>
  <div class="kv-search-results" data-testid="search-results">
    <!-- ARIA's listbox role only permits `option`/`group` children (`aria-required-children`) —
         the status line, section titles and options live inside this inner listbox div; the
         stale hint, footers and the body-search button are its *siblings*, not its children. -->
    <div :id="SEARCH_LISTBOX_ID" role="listbox" aria-label="Search results">
      <div v-if="searching" class="kv-search-status" data-testid="search-status">Searching…</div>

      <template v-for="section in model.sections" :key="section.title">
        <div class="kv-search-section-title">
          {{ section.title }} <span class="kv-search-section-count">({{ section.options.length }})</span>
        </div>

        <template v-for="option in section.options" :key="option.id">
          <div
            :id="option.id"
            role="option"
            class="kv-search-option"
            :class="{ 'kv-search-option--active': option.id === highlightedId }"
            :aria-selected="option.id === highlightedId"
            @click="emit('select', option)"
            @mouseenter="emit('hover', option)"
          >
            <template v-if="option.kind === 'ref'">
              <span
                class="codicon"
                :class="{
                  'codicon-git-branch': option.hit.ref.kind === 'branch',
                  'codicon-cloud': option.hit.ref.kind === 'remoteBranch',
                  'codicon-tag': option.hit.ref.kind === 'tag',
                }"
                aria-hidden="true"
              ></span>
              <span class="kv-search-option-main">{{ option.hit.ref.shortName }}</span>
              <span v-if="fieldLabel(option.hit.fields)" class="kv-search-option-field">
                {{ fieldLabel(option.hit.fields) }}
              </span>
            </template>
            <template v-else>
              <span class="kv-search-option-sha">{{ option.hit.sha.slice(0, 7) }}</span>
              <span class="kv-search-option-main">{{ option.hit.subject }}</span>
              <span class="kv-search-option-author">{{ option.hit.authorName }}</span>
              <span class="kv-search-option-date">{{ formatRelativeDate(option.hit.authorTime) }}</span>
              <span v-if="fieldLabel(option.hit.fields)" class="kv-search-option-field">
                {{ fieldLabel(option.hit.fields) }}
              </span>
            </template>
          </div>
        </template>
        <div v-if="section.hiddenCount > 0" class="kv-search-more">
          {{ section.hiddenCount }} more — refine your search
        </div>
      </template>

      <div v-if="isEmpty" class="kv-search-empty">No results</div>
    </div>

    <div v-if="tailStale" class="kv-search-hint" data-testid="search-tail-stale">
      Refs changed since this search ran
    </div>
    <div v-if="model.loadedFooter" class="kv-search-footer">{{ model.loadedFooter }}</div>
    <div v-if="model.tailFooter" class="kv-search-footer">{{ model.tailFooter }}</div>
    <button
      v-if="showBodySearchAffordance"
      type="button"
      class="kv-search-body-button"
      data-testid="search-body-button"
      @click="emit('runBodySearch')"
    >
      Search message bodies
    </button>
  </div>
</template>

<style>
.kv-search-results {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 10;
  width: 420px;
  max-height: 360px;
  overflow-y: auto;
  padding: var(--kv-space-1) 0;
  background-color: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 2px 8px var(--kv-widget-shadow);
}

.kv-search-status {
  padding: var(--kv-space-1) var(--kv-space-3);
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-search-section-title {
  padding: var(--kv-space-1) var(--kv-space-3);
  font-size: 0.85em;
  font-weight: 600;
  color: var(--kv-description-fg);
}

.kv-search-section-count {
  font-weight: 400;
}

.kv-search-option {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-1) var(--kv-space-3);
  cursor: pointer;
  white-space: nowrap;
}

.kv-search-option:hover,
.kv-search-option--active {
  background-color: var(--kv-row-hover-bg);
}

.kv-search-option-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kv-search-option-sha {
  font-family: var(--kv-mono-font-family);
  color: var(--kv-description-fg);
}

.kv-search-option-author,
.kv-search-option-date {
  color: var(--kv-description-fg);
  font-size: 0.9em;
}

.kv-search-option-field {
  padding: 0 var(--kv-space-1);
  color: var(--kv-description-fg);
  font-size: 0.8em;
  border: 1px dashed var(--kv-panel-border);
  border-radius: var(--kv-radius);
}

.kv-search-more,
.kv-search-empty,
.kv-search-hint,
.kv-search-footer {
  padding: var(--kv-space-1) var(--kv-space-3);
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-search-body-button {
  display: block;
  width: 100%;
  padding: var(--kv-space-1) var(--kv-space-3);
  background: transparent;
  color: var(--kv-app-fg);
  border: none;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}

.kv-search-body-button:hover {
  background-color: var(--kv-row-hover-bg);
}
</style>
