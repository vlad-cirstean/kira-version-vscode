<script setup lang="ts">
/**
 * `docs/plans/P5.md` W7: §6.4 items 1 and 3 — message at the top of the pane, details at the
 * bottom, with `FileTree.vue` (item 2) between them in `DetailPane.vue`'s own template; this
 * component only ever renders its own two pieces.
 *
 * Every DOM-touching bit (message linkification, ref badges) is built through `linkify.ts`'s
 * `appendLinkifiedText`/`refBadges.ts`'s `buildRefBadges` rather than a template `v-html` — a
 * commit message is untrusted text and this repo's `enableHtmlRendering: false` discipline
 * (`columns.ts`'s own doc comment) applies here just as much as it does inside the grid.
 */
import type { CommitStore } from "@kira-version/core";
import { computed, nextTick, ref, watch } from "vue";
import type { DetailActions } from "../state/detailActions.ts";
import type { CommitDetail } from "../state/detail.ts";
import { buildRefBadges } from "./refBadges.ts";
import { appendLinkifiedText } from "./linkify.ts";

const props = defineProps<{
  detail: CommitDetail | undefined;
  store: CommitStore;
  actions: DetailActions;
  /** §6.4's "message, then files, then details" ordering means `DetailPane.vue` has to put its
   *  own `<FileTree>` *between* this component's two halves — so it mounts this component twice,
   *  once per section, rather than this file owning where the tree sits. */
  section: "message" | "details";
}>();

/** A loaded parent's sha button was clicked — `DetailPane.vue`/`App.vue` own turning this into
 *  an actual selection change (this component only reads `store`, it never writes to it). */
const emit = defineEmits<(e: "selectParentCommit", sha: string) => void>();

const bodyEl = ref<HTMLParagraphElement | null>(null);
const decorationEl = ref<HTMLSpanElement | null>(null);

/** Body lines rendered one `<p>` per blank-line-separated paragraph — `appendLinkifiedText`
 *  handles a paragraph's own line breaks by joining with `\n` inside one paragraph rather than
 *  trying to linkify a single giant string with embedded `<br>`s. */
const bodyParagraphs = computed<string[]>(() => {
  const body = props.detail?.body ?? "";
  if (body.trim() === "") return [];
  return body.split(/\n{2,}/).map((p) => p.trim());
});

function renderBody(): void {
  const container = bodyEl.value;
  if (!container) return;
  container.replaceChildren();
  for (const [index, paragraph] of bodyParagraphs.value.entries()) {
    if (index > 0) container.appendChild(document.createElement("br"));
    if (index > 0) container.appendChild(document.createElement("br"));
    const lines = paragraph.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) container.appendChild(document.createElement("br"));
      appendLinkifiedText(container, line);
    });
  }
}

function renderDecoration(): void {
  const container = decorationEl.value;
  if (!container) return;
  container.replaceChildren();
  const badges = buildRefBadges(props.detail?.decoration ?? []);
  if (badges) container.appendChild(badges);
}

watch([() => props.detail, bodyEl], () => void nextTick(renderBody), { immediate: true });
watch([() => props.detail?.decoration, decorationEl], () => void nextTick(renderDecoration), {
  immediate: true,
});

const shortSha = computed(() => props.detail?.sha.slice(0, 7) ?? "");

interface ParentRow {
  readonly sha: string;
  readonly shortSha: string;
  readonly loaded: boolean;
}

const parentRows = computed<ParentRow[]>(() =>
  (props.detail?.parents ?? []).map((sha) => ({
    sha,
    shortSha: sha.slice(0, 7),
    loaded: props.store.rowOfSha(sha) !== -1,
  })),
);

/** §6.4: "author and committer with both timestamps when they differ" — read as: show one
 *  identity row when author and committer are the very same identity at the very same moment
 *  (the overwhelmingly common case), and both, each with its own timestamp, the moment any part
 *  differs (a rebase, a cherry-pick, an `--author` override) — never silently collapse two
 *  genuinely different facts into one row. */
const committerDiffersFromAuthor = computed(() => {
  const detail = props.detail;
  if (!detail) return false;
  return (
    detail.author.name !== detail.committer.name ||
    detail.author.email !== detail.committer.email ||
    detail.author.timestamp !== detail.committer.timestamp
  );
});

const SIGNATURE_TEXT: Readonly<Record<string, string>> = {
  G: "Good signature",
  B: "Bad signature",
  U: "Good signature, unknown validity",
  X: "Good signature, expired signature",
  Y: "Good signature, expired key",
  R: "Good signature, revoked key",
  E: "Cannot check signature",
};

/** `undefined` for an unsigned commit (`status: "N"`) — §6.4/W7: "an unsigned commit shows no
 *  row, not an empty one". */
const signatureText = computed<string | undefined>(() => {
  const signature = props.detail?.signature;
  if (!signature || signature.status === "N") return undefined;
  const text = SIGNATURE_TEXT[signature.status] ?? signature.status;
  return signature.signer ? `${text} by ${signature.signer}` : text;
});

const COAUTHOR_TOKENS = new Set(["Co-authored-by", "Signed-off-by"]);
const IDENTITY_TRAILER = /^(.*)\s<(.+)>$/;

interface TrailerRow {
  readonly token: string;
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly raw: string;
}

/** `Co-authored-by`/`Signed-off-by` (§6.4's own two named trailers) parse their `Name <email>`
 *  shape into separate name/email display so the email can be styled as secondary text; every
 *  other trailer renders its value verbatim — this repo does not try to out-guess git's own
 *  trailer syntax for tokens it has not been told carry an identity. */
const trailerRows = computed<TrailerRow[]>(() =>
  (props.detail?.trailers ?? []).map((trailer) => {
    if (COAUTHOR_TOKENS.has(trailer.token)) {
      const match = IDENTITY_TRAILER.exec(trailer.value);
      if (match) {
        const [, name, email] = match;
        return { token: trailer.token, name: name?.trim(), email, raw: trailer.value };
      }
    }
    return { token: trailer.token, name: undefined, email: undefined, raw: trailer.value };
  }),
);

function copyFullSha(): void {
  if (props.detail) props.actions.copy(props.detail.sha, "full SHA");
}

function copyShortSha(): void {
  if (props.detail) props.actions.copy(shortSha.value, "short SHA");
}

function copyMessage(): void {
  const detail = props.detail;
  if (!detail) return;
  const full = detail.body.trim() === "" ? detail.subject : `${detail.subject}\n\n${detail.body}`;
  props.actions.copy(full, "commit message");
}
</script>

<template>
  <div v-if="detail" class="kv-commit-meta" data-testid="commit-meta">
    <section v-if="section === 'message'" class="kv-meta-message" aria-label="Commit message">
      <div class="kv-meta-message-header">
        <h2 class="kv-meta-subject">{{ detail.subject }}</h2>
        <button
          v-if="actions.capabilities.clipboard"
          type="button"
          class="kv-copy-button"
          title="Copy full message"
          @click="copyMessage"
        >
          <span class="codicon codicon-copy" aria-hidden="true"></span>
        </button>
      </div>
      <p v-if="bodyParagraphs.length > 0" ref="bodyEl" class="kv-meta-body"></p>
      <dl v-if="trailerRows.length > 0" class="kv-meta-trailers">
        <template v-for="(row, index) in trailerRows" :key="index">
          <dt>{{ row.token }}</dt>
          <dd v-if="row.name !== undefined">
            {{ row.name }} <span class="kv-meta-trailer-email">&lt;{{ row.email }}&gt;</span>
          </dd>
          <dd v-else>{{ row.raw }}</dd>
        </template>
      </dl>
    </section>

    <section v-if="section === 'details'" class="kv-meta-details" aria-label="Commit details">
      <dl class="kv-meta-details-list">
        <dt>SHA</dt>
        <dd class="kv-meta-sha-row">
          <span class="kv-meta-mono">{{ detail.sha }}</span>
          <button
            v-if="actions.capabilities.clipboard"
            type="button"
            class="kv-copy-button"
            title="Copy full SHA"
            @click="copyFullSha"
          >
            <span class="codicon codicon-copy" aria-hidden="true"></span>
          </button>
        </dd>
        <dt>Short SHA</dt>
        <dd class="kv-meta-sha-row">
          <span class="kv-meta-mono">{{ shortSha }}</span>
          <button
            v-if="actions.capabilities.clipboard"
            type="button"
            class="kv-copy-button"
            title="Copy short SHA"
            @click="copyShortSha"
          >
            <span class="codicon codicon-copy" aria-hidden="true"></span>
          </button>
        </dd>
        <template v-if="parentRows.length > 0">
          <dt>{{ parentRows.length > 1 ? "Parents" : "Parent" }}</dt>
          <dd class="kv-meta-parents">
            <button
              v-for="parent in parentRows"
              :key="parent.sha"
              type="button"
              class="kv-meta-parent"
              :disabled="!parent.loaded"
              :title="parent.loaded ? '' : 'Not loaded — load more history to reach it'"
              @click="emit('selectParentCommit', parent.sha)"
            >
              {{ parent.shortSha }}
            </button>
          </dd>
        </template>
        <template v-if="!committerDiffersFromAuthor">
          <dt>Author</dt>
          <dd>{{ detail.author.name }} &lt;{{ detail.author.email }}&gt;</dd>
        </template>
        <template v-else>
          <dt>Author</dt>
          <dd>{{ detail.author.name }} &lt;{{ detail.author.email }}&gt;</dd>
          <dt>Committer</dt>
          <dd>{{ detail.committer.name }} &lt;{{ detail.committer.email }}&gt;</dd>
        </template>
        <dt v-if="decorationEl?.childNodes.length">Refs</dt>
        <dd v-show="decorationEl?.childNodes.length" ref="decorationEl" class="kv-meta-refs"></dd>
        <template v-if="signatureText">
          <dt>Signature</dt>
          <dd>{{ signatureText }}</dd>
        </template>
      </dl>
    </section>
  </div>
</template>

<style>
.kv-commit-meta {
  padding: var(--kv-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--kv-space-4);
}

.kv-meta-message-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--kv-space-2);
}

.kv-meta-subject {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
}

.kv-meta-body {
  margin: var(--kv-space-2) 0 0;
  white-space: normal;
}

.kv-meta-body a {
  color: var(--kv-focus-border);
}

.kv-meta-trailers {
  margin: var(--kv-space-3) 0 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--kv-space-1) var(--kv-space-3);
  font-size: 0.92em;
}

.kv-meta-trailers dt {
  color: var(--kv-description-fg);
}

.kv-meta-trailers dd {
  margin: 0;
}

.kv-meta-trailer-email {
  color: var(--kv-description-fg);
}

.kv-meta-details-list {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--kv-space-1) var(--kv-space-3);
  font-size: 0.92em;
}

.kv-meta-details-list dt {
  color: var(--kv-description-fg);
}

.kv-meta-details-list dd {
  margin: 0;
}

.kv-meta-mono {
  font-family: var(--kv-mono-font-family);
  font-size: var(--kv-mono-font-size);
}

.kv-meta-sha-row {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
}

.kv-copy-button {
  background: transparent;
  border: none;
  color: var(--kv-row-fg);
  cursor: pointer;
  padding: 0 var(--kv-space-1);
  opacity: 0.8;
}

.kv-copy-button:hover {
  opacity: 1;
}

.kv-meta-parents {
  display: flex;
  flex-wrap: wrap;
  gap: var(--kv-space-2);
}

.kv-meta-parent {
  font-family: var(--kv-mono-font-family);
  font-size: var(--kv-mono-font-size);
  background: transparent;
  border: 1px solid var(--kv-panel-border);
  color: var(--kv-row-fg);
  border-radius: var(--kv-radius);
  padding: 0 var(--kv-space-2);
  cursor: pointer;
}

.kv-meta-parent:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.kv-meta-refs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--kv-space-1);
}
</style>
