<script setup lang="ts">
/**
 * `docs/plans/P5.md` W9: the third region — the in-app unified diff, opened by a tree click or
 * `Enter` and taking over the pane (or, at the overlay breakpoint, the whole graph) per the
 * plan's own breakpoint table. `DetailPane.vue` decides *whether* this is showing
 * (`DetailState.mode === "diff"`); this component only ever renders the one diff it is given.
 *
 * W10's "Open in editor"/"Go to file" actions live in this file's header because both need the
 * diff's own `focusedRow` — the row the user last clicked, defaulting to the first content row —
 * and neither makes sense anywhere selection of a specific line is not possible (§6.4's file
 * tree has no such thing).
 */
import { type DiffRow, flattenDiffRows, mapDiffLineToRevision } from "@kira-version/core";
import { computed, ref, watch } from "vue";
import type { FileDiffResult } from "../state/detail.ts";
import type { DetailActions } from "../state/detailActions.ts";

const props = defineProps<{
  diff: FileDiffResult | undefined;
  diffError: string | undefined;
  /** Index of the currently open file into the commit's *full, unfiltered* `files` array — used
   *  only for the header's "N of M" position, never for `fileTreeModel.ts`'s own row identity. */
  fileIndex: number;
  totalFiles: number;
  actions: DetailActions;
}>();

const emit = defineEmits<{
  (e: "selectFile", fileIndex: number): void;
  (e: "back"): void;
}>();

function goBack(): void {
  emit("back");
}

function moveFile(delta: number): void {
  const next = props.fileIndex + delta;
  if (next < 0 || next >= props.totalFiles) return;
  emit("selectFile", next);
}

const LINE_SCROLL_PX = 19;

const bodyEl = ref<HTMLDivElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    moveFile(event.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    bodyEl.value?.scrollBy({ top: -LINE_SCROLL_PX });
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    bodyEl.value?.scrollBy({ top: LINE_SCROLL_PX });
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "Backspace") {
    event.preventDefault();
    goBack();
  }
}

const rows = computed<DiffRow[]>(() => {
  const body = props.diff?.body;
  if (body?.kind !== "text") return [];
  return flattenDiffRows(body.hunks);
});

/** The cursor "Go to file" maps — defaults to the first real content row (a hunk header has no
 *  line of its own to map), set by clicking any row thereafter. Reset whenever the diff itself
 *  changes (a new file, or a re-fetch after `parentIndex` changes) — a row index from the
 *  previous file means nothing against this one's hunks. */
const focusedRow = ref(0);
watch(
  () => props.diff,
  () => {
    const firstLineRow = rows.value.findIndex((row) => row.kind === "line");
    focusedRow.value = firstLineRow === -1 ? 0 : firstLineRow;
    actionMessage.value = "";
  },
);

function rowKey(row: DiffRow, index: number): string {
  return row.kind === "hunkHeader"
    ? `h${row.hunkIndex}`
    : `h${row.hunkIndex}l${row.lineIndex}-${index}`;
}

function lineClass(row: DiffRow): string {
  if (row.kind !== "line") return "";
  const body = props.diff?.body;
  if (body?.kind !== "text") return "";
  const line = body.hunks[row.hunkIndex]?.lines[row.lineIndex];
  if (line?.kind === "add") return "kv-diff-line-add";
  if (line?.kind === "del") return "kv-diff-line-del";
  return "";
}

/** P5 W14: "each row's accessible name states its kind in words" — read instead of the visual
 *  `+`/`−` glyph (`aria-hidden` in the template), which a screen reader has no reliable way to
 *  pronounce as "added"/"deleted" on its own. */
function rowAccessibleName(row: DiffRow): string {
  const body = props.diff?.body;
  if (body?.kind !== "text") return "";
  const hunk = body.hunks[row.hunkIndex];
  if (row.kind === "hunkHeader") {
    return `Hunk: old line ${hunk?.oldStart}, new line ${hunk?.newStart}${hunk?.heading ? `, ${hunk.heading}` : ""}`;
  }
  const line = hunk?.lines[row.lineIndex];
  if (!line) return "";
  if (line.kind === "add") return `Line ${line.newLine}, added: ${line.text}`;
  if (line.kind === "del") return `Line ${line.oldLine}, deleted: ${line.text}`;
  return `Line ${line.oldLine}/${line.newLine}, unchanged: ${line.text}`;
}

const actionMessage = ref("");
let actionMessageTimer: ReturnType<typeof setTimeout> | undefined;
function showActionMessage(text: string): void {
  actionMessage.value = text;
  props.actions.announce(text);
  if (actionMessageTimer) clearTimeout(actionMessageTimer);
  actionMessageTimer = setTimeout(() => {
    actionMessage.value = "";
  }, 4000);
}

const canOpenInEditor = computed(() => {
  if (!props.actions.capabilities.openInEditor || !props.diff) return false;
  const kind = props.diff.body.kind;
  return kind !== "lfsPointer" && kind !== "tooLarge";
});

const canGoToFile = computed(
  () => props.actions.capabilities.goToFile && props.diff?.body.kind === "text",
);

async function openInEditor(): Promise<void> {
  const diff = props.diff;
  if (!diff) return;
  try {
    await props.actions.openInEditor({
      sha: diff.sha,
      path: diff.change.path,
      originalPath: diff.change.originalPath,
      parentIndex: diff.parentIndex,
    });
    showActionMessage(`Opened ${diff.change.path} in the editor`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showActionMessage(`Couldn't open in the editor — ${reason}`);
  }
}

async function goToFile(): Promise<void> {
  const diff = props.diff;
  const body = diff?.body;
  if (!diff || !body || body.kind !== "text") return;
  const side = diff.change.kind === "deleted" ? "old" : "new";
  const rev = side === "old" ? diff.baseSha : diff.sha;
  if (rev === null) return; // a root commit's deleted-side has no pre-image revision to open
  const path = side === "old" ? (diff.change.originalPath ?? diff.change.path) : diff.change.path;
  const line = mapDiffLineToRevision(body.hunks, focusedRow.value, side);
  const shortRev = rev.slice(0, 7);
  try {
    const outcome = await props.actions.goToFile({ rev, path, line });
    if (outcome.kind === "liveFile") {
      showActionMessage(`Opened ${outcome.path} at line ${outcome.line}`);
    } else if (outcome.kind === "virtualBlob") {
      showActionMessage(`Opened the version from ${shortRev} — this path is not in your checkout`);
    } else if (outcome.reason === "notInRevision") {
      showActionMessage(`${path} is not in ${shortRev}`);
    } else if (outcome.reason === "binary") {
      showActionMessage(`${path} is binary in ${shortRev}`);
    } else {
      showActionMessage(`${path} is too large to open in ${shortRev}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showActionMessage(`Couldn't go to file — ${reason}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div class="kv-diff-view" data-testid="diff-view" tabindex="0" @keydown="onKeydown">
    <header class="kv-diff-header">
      <button type="button" class="kv-diff-back" title="Back to files" @click="goBack">
        <span class="codicon codicon-chevron-left" aria-hidden="true"></span>
        Files
      </button>
      <span class="kv-diff-position">{{ fileIndex + 1 }} of {{ totalFiles }}</span>
      <span v-if="diff" class="kv-diff-path" :title="diff.change.path">{{ diff.change.path }}</span>
      <div class="kv-diff-nav">
        <button
          type="button"
          title="Previous file (Alt+Up)"
          :disabled="fileIndex <= 0"
          @click="moveFile(-1)"
        >
          <span class="codicon codicon-chevron-right" style="transform: rotate(180deg)" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          title="Next file (Alt+Down)"
          :disabled="fileIndex >= totalFiles - 1"
          @click="moveFile(1)"
        >
          <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
        </button>
      </div>
      <button v-if="canOpenInEditor" type="button" class="kv-diff-action" @click="openInEditor">
        Open in editor
      </button>
      <button v-if="canGoToFile" type="button" class="kv-diff-action" @click="goToFile">
        Go to file
      </button>
    </header>

    <p v-if="actionMessage" class="kv-diff-action-message" role="status">{{ actionMessage }}</p>

    <div v-if="diffError" class="kv-diff-message">Couldn't load this diff — {{ diffError }}</div>

    <template v-else-if="diff">
      <div
        v-if="diff.body.kind === 'text'"
        ref="bodyEl"
        class="kv-diff-body"
        role="table"
        :aria-label="`Diff for ${diff.change.path}`"
      >
        <div
          v-for="(row, index) in rows"
          :key="rowKey(row, index)"
          class="kv-diff-row"
          :class="[lineClass(row), { 'kv-diff-row-focused': index === focusedRow }]"
          role="row"
          :aria-label="rowAccessibleName(row)"
          @click="focusedRow = index"
        >
          <template v-if="row.kind === 'hunkHeader'">
            <div class="kv-diff-hunk-header" role="cell">
              @@ -{{ diff.body.hunks[row.hunkIndex]?.oldStart }},{{
                diff.body.hunks[row.hunkIndex]?.oldLines
              }}
              +{{ diff.body.hunks[row.hunkIndex]?.newStart }},{{
                diff.body.hunks[row.hunkIndex]?.newLines
              }}
              @@ {{ diff.body.hunks[row.hunkIndex]?.heading }}
            </div>
          </template>
          <template v-else>
            <span class="kv-diff-gutter kv-diff-gutter-old" role="cell">{{
              diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.oldLine ?? ""
            }}</span>
            <span class="kv-diff-gutter kv-diff-gutter-new" role="cell">{{
              diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.newLine ?? ""
            }}</span>
            <span class="kv-diff-marker" aria-hidden="true">{{
              diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.kind === "add"
                ? "+"
                : diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.kind === "del"
                  ? "−"
                  : ""
            }}</span>
            <span class="kv-diff-text" role="cell">{{
              diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.text
            }}</span>
            <span
              v-if="diff.body.hunks[row.hunkIndex]?.lines[row.lineIndex]?.noNewlineAtEof"
              class="kv-diff-no-newline"
              >\ No newline at end of file</span
            >
          </template>
        </div>
      </div>

      <div v-else-if="diff.body.kind === 'binary'" class="kv-diff-message">
        Binary file — not shown
        <template v-if="diff.body.oldBytes !== undefined && diff.body.newBytes !== undefined">
          ({{ formatBytes(diff.body.oldBytes) }} → {{ formatBytes(diff.body.newBytes) }})
        </template>
      </div>

      <div v-else-if="diff.body.kind === 'lfsPointer'" class="kv-diff-message">
        LFS object, not fetched — {{ formatBytes(diff.body.bytes) }}
      </div>

      <div v-else-if="diff.body.kind === 'tooLarge'" class="kv-diff-message">
        File too large to display ({{ formatBytes(diff.body.bytes) }}, limit
        {{ formatBytes(diff.body.limitBytes) }})
      </div>

      <div v-else-if="diff.body.kind === 'empty'" class="kv-diff-message">
        {{
          diff.body.reason === "modeChangeOnly"
            ? "No content change — file mode changed"
            : "No content change"
        }}
      </div>
    </template>

    <div v-else class="kv-diff-message">Loading…</div>
  </div>
</template>

<style>
.kv-diff-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  outline: none;
}

.kv-diff-header {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-2) var(--kv-space-4);
  border-bottom: 1px solid var(--kv-panel-border);
}

.kv-diff-back {
  background: transparent;
  color: var(--kv-row-fg);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--kv-space-1);
}

.kv-diff-position {
  color: var(--kv-description-fg);
  font-size: 0.85em;
  white-space: nowrap;
}

.kv-diff-path {
  font-family: var(--kv-mono-font-family);
  font-size: var(--kv-mono-font-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.kv-diff-nav {
  display: flex;
  gap: var(--kv-space-1);
}

.kv-diff-nav button,
.kv-diff-action {
  background: transparent;
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  cursor: pointer;
  padding: 0 var(--kv-space-2);
}

.kv-diff-nav button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kv-diff-action-message {
  margin: 0;
  padding: var(--kv-space-1) var(--kv-space-4);
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-diff-message {
  padding: var(--kv-space-4);
  color: var(--kv-description-fg);
}

.kv-diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: var(--kv-mono-font-family);
  font-size: var(--kv-mono-font-size);
}

.kv-diff-row {
  display: flex;
  align-items: baseline;
  white-space: pre;
  cursor: pointer;
}

.kv-diff-row-focused {
  background-color: var(--kv-line-highlight-bg);
}

.kv-diff-hunk-header {
  padding: var(--kv-space-1) var(--kv-space-2);
  color: var(--kv-description-fg);
  white-space: normal;
}

.kv-diff-gutter {
  width: 3.5em;
  flex-shrink: 0;
  text-align: right;
  padding-right: var(--kv-space-2);
  color: var(--kv-description-fg);
  user-select: none;
}

.kv-diff-marker {
  width: 1em;
  flex-shrink: 0;
  text-align: center;
  user-select: none;
}

.kv-diff-line-add {
  background-color: var(--kv-diff-inserted-bg);
}

.kv-diff-line-del {
  background-color: var(--kv-diff-removed-bg);
}

.kv-diff-no-newline {
  margin-left: var(--kv-space-2);
  color: var(--kv-description-fg);
  font-style: italic;
}
</style>
