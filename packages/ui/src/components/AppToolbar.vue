<script setup lang="ts">
/**
 * §6.2's toolbar: `[repo ▾] [branch ▾] │ ⟳ │ Fetch Pull Push │ Stash ▾ │ Search […] ⚙`. P4 built
 * only the first and third groups; P6 (W13/W17) adds the second — the branch/tag picker — and the
 * undo affordance, since both need P6's ref list and op executor. `docs/plans/P8.md` W17 adds the
 * fetch/pull/push group itself; search needs P10 and stays absent, not a disabled placeholder.
 *
 * Metrics match the panel title bar's, not an invented toolbar height (§6.1): 35px
 * (`--kv-toolbar-height`), square corners (`--kv-radius: 0`), no shadow.
 *
 * There is no `remotes.list` endpoint (P6/P8 both skip it, per `rowMenuModel.ts`'s own
 * `remoteNamesFrom` doc comment) and remote *management* is out of scope entirely (§10's scope
 * table), so this toolbar assumes the single-remote-per-repo shape every other P8 affordance
 * assumes and reads the remote's name from whatever remote-tracking branches already loaded —
 * `defaultRemote` below. Fetch/Pull/Push are simply absent (not disabled) when no remote is
 * known at all: there is nothing to name in the tooltip and no useful default to pick.
 */
import { computed, ref } from "vue";
import type { DetailActions } from "../state/detailActions.ts";
import type { GraphViewState } from "../state/graphView.ts";
import type { OpsState } from "../state/ops.ts";
import type { RefsState } from "../state/refs.ts";
import type { RepoState } from "../state/repo.ts";
import BranchPicker from "./BranchPicker.vue";
import PullStrategyPicker from "./PullStrategyPicker.vue";
import RefreshButton from "./RefreshButton.vue";
import { remoteNamesFrom } from "./rowMenuModel.ts";
import RepoPicker from "./RepoPicker.vue";
import UndoButton from "./UndoButton.vue";

const props = defineProps<{
  graphView: GraphViewState;
  repoState: RepoState;
  refsState: RefsState;
  opsState: OpsState;
  actions: DetailActions | undefined;
}>();
const emit = defineEmits<(event: "repo-opened", repoId: string) => void>();

function copy(text: string, whatCopied: string): void {
  props.actions?.copy(text, whatCopied);
}

const refreshButtonRef = ref<InstanceType<typeof RefreshButton> | null>(null);

// Forwarded so App.vue can drive the same refresh RefreshButton's own click uses from
// CommitGrid.vue's "refresh" emit (F5/Ctrl+R while the grid has focus) — one implementation,
// reached from two inputs, rather than App.vue reimplementing RefreshButton's own idempotency
// and hasPendingChange bookkeeping a second time.
defineExpose({ refresh: () => refreshButtonRef.value?.refresh() });

// ---------------------------------------------------------------------------------------
// P8 W17: fetch/pull/push
// ---------------------------------------------------------------------------------------

const defaultRemote = computed(
  () => remoteNamesFrom(props.refsState.remoteBranches.value.map((row) => row.shortName))[0],
);
const currentBranch = computed(() => props.refsState.currentBranchName.value);
const hasRemote = computed(() => defaultRemote.value !== undefined);
/** A conflicting merge/rebase (or anything else in P6's in-progress banner) blocks Pull/Push —
 *  both would touch a worktree or history that is mid-operation — but never blocks Fetch, which
 *  touches neither (§4.3/D50's own distinction, read forward into the toolbar's own gate). */
const inConflict = computed(() => props.opsState.statusSummary.value?.inProgress !== null);
const remoteBusy = computed(() => props.opsState.activeRemoteOp.value !== undefined);

const fetchDisabled = computed(() => !hasRemote.value || props.opsState.busy.value);
const pushPullDisabled = computed(
  () =>
    !hasRemote.value ||
    currentBranch.value === undefined ||
    props.opsState.busy.value ||
    inConflict.value,
);

const isForcePushMenuOpen = ref(false);

function toggleForcePushMenu(): void {
  isForcePushMenuOpen.value = !isForcePushMenuOpen.value;
}

async function doFetch(): Promise<void> {
  const remote = defaultRemote.value;
  if (remote === undefined) return;
  await props.opsState.runFetch(remote);
}

async function doPush(): Promise<void> {
  const remote = defaultRemote.value;
  const branch = currentBranch.value;
  if (remote === undefined || branch === undefined) return;
  await props.opsState.runPush(remote, branch);
}

async function doForcePush(): Promise<void> {
  isForcePushMenuOpen.value = false;
  const remote = defaultRemote.value;
  const branch = currentBranch.value;
  if (remote === undefined || branch === undefined) return;
  await props.opsState.runForcePush(remote, branch);
}

const remoteOpLabel: Record<string, string> = {
  fetch: "Fetching",
  pull: "Pulling",
  push: "Pushing",
  forcePush: "Force pushing",
  deleteRemoteBranch: "Deleting remote branch",
};

const progressText = computed(() => {
  const kind = props.opsState.activeRemoteOp.value;
  if (kind === undefined) return "";
  const progress = props.opsState.remoteProgress.value;
  if (!progress) return `${remoteOpLabel[kind]}…`;
  const prefix = progress.remote ? "Remote: " : "";
  const pct = progress.percent === undefined ? "" : ` ${progress.percent}%`;
  return `${prefix}${progress.phase}${pct}`;
});

/** D50's cancellability table, read into the toolbar's own affordance: only fetch and pull's own
 *  fetch phase are killable, so the button is disabled-with-reason for the other three kinds
 *  rather than hidden — clicking it while, say, a push is in flight is a legitimate thing to try,
 *  and `remote.cancel` answers honestly (`cancelled: false`) either way (W19's own "cancel is
 *  refused mid-push" criterion). */
const cancelDisabledReason = computed(() => {
  switch (props.opsState.activeRemoteOp.value) {
    case "fetch":
    case "pull":
      return undefined;
    case "push":
      return "A push in flight cannot be cancelled — its outcome on the remote would be unknown.";
    case "forcePush":
      return "A force push in flight cannot be cancelled.";
    case "deleteRemoteBranch":
      return "This cannot be cancelled once it has started.";
    default:
      return "Nothing is running.";
  }
});
const cancellable = computed(() => cancelDisabledReason.value === undefined);

async function doCancel(): Promise<void> {
  await props.opsState.cancelRemote();
}
</script>

<template>
  <!-- W14 (axe `aria-allowed-role`): `role="toolbar"` is not among the roles the ARIA spec
       allows overriding a `<header>`'s own implicit "banner" role with — a plain `<div>` carries
       no implicit role of its own to conflict with the explicit one, which is all this element
       ever wanted (§6.2's own layout, not a page banner). -->
  <div class="kv-toolbar" role="toolbar" aria-label="Kira Version toolbar">
    <RepoPicker :repo-state="repoState" @repo-opened="(repoId) => emit('repo-opened', repoId)" />
    <BranchPicker :refs="refsState" :ops="opsState" />
    <span class="kv-toolbar-separator" aria-hidden="true"></span>
    <RefreshButton ref="refreshButtonRef" :graph-view="graphView" :repo-state="repoState" />

    <template v-if="hasRemote">
      <span class="kv-toolbar-separator" aria-hidden="true"></span>
      <button
        type="button"
        class="kv-toolbar-button"
        :disabled="fetchDisabled"
        :title="`Fetch ${defaultRemote}`"
        data-testid="fetch-button"
        @click="doFetch"
      >
        <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
        <span>Fetch</span>
      </button>

      <PullStrategyPicker
        v-if="currentBranch !== undefined"
        :ops="opsState"
        :remote="defaultRemote as string"
        :branch="currentBranch"
        :disabled="pushPullDisabled"
      />

      <div class="kv-push-group">
        <button
          type="button"
          class="kv-toolbar-button kv-push-main"
          :disabled="pushPullDisabled"
          :title="`Push to ${defaultRemote}`"
          data-testid="push-button"
          @click="doPush"
        >
          <span class="codicon codicon-repo-push" aria-hidden="true"></span>
          <span>Push</span>
        </button>
        <button
          type="button"
          class="kv-toolbar-button kv-push-chevron"
          :disabled="pushPullDisabled"
          aria-label="Push options"
          :aria-expanded="isForcePushMenuOpen"
          data-testid="push-overflow-trigger"
          @click="toggleForcePushMenu"
        >
          <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
        </button>
        <div v-if="isForcePushMenuOpen" class="kv-push-menu" role="menu" aria-label="Push options">
          <button
            type="button"
            class="kv-push-menu-item"
            role="menuitem"
            data-testid="force-push-trigger"
            @click="doForcePush"
          >
            Force push…
          </button>
        </div>
      </div>
    </template>

    <span class="kv-toolbar-spacer" aria-hidden="true"></span>

    <div v-if="remoteBusy" class="kv-remote-progress" data-testid="remote-progress">
      <span class="codicon codicon-loading kv-remote-progress-spin" aria-hidden="true"></span>
      <span class="kv-remote-progress-label">{{ progressText }}</span>
      <button
        type="button"
        class="kv-icon-button"
        :disabled="!cancellable"
        :title="cancellable ? 'Cancel' : cancelDisabledReason"
        data-testid="remote-cancel"
        @click="doCancel"
      >
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </div>

    <UndoButton :ops="opsState" :clipboard-enabled="actions?.capabilities.clipboard ?? false" :copy="copy" />
  </div>
</template>

<style>
.kv-toolbar {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  height: var(--kv-toolbar-height);
  padding: 0 var(--kv-space-3);
  background-color: var(--kv-toolbar-bg);
  border-bottom: 1px solid var(--kv-toolbar-border);
  flex-shrink: 0;
}

.kv-toolbar-separator {
  width: 1px;
  align-self: stretch;
  margin: var(--kv-space-2) 0;
  background-color: var(--kv-toolbar-border);
}

.kv-toolbar-spacer {
  flex: 1;
}

/* Shared with `PullStrategyPicker.vue`'s own trigger buttons — see that file's own doc comment
   on why this is defined identically in both places rather than one importing the other's CSS. */
.kv-toolbar-button {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-1);
  height: 22px;
  padding: 0 var(--kv-space-2);
  background: transparent;
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-toolbar-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-toolbar-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.kv-push-group {
  position: relative;
  display: inline-flex;
}

.kv-push-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.kv-push-chevron {
  padding: 0 var(--kv-space-1);
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.kv-push-menu {
  position: absolute;
  top: calc(100% + var(--kv-space-1));
  right: 0;
  z-index: 30;
  min-width: 160px;
  padding: var(--kv-space-1);
  background-color: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 4px 16px var(--kv-widget-shadow);
}

.kv-push-menu-item {
  display: block;
  width: 100%;
  padding: var(--kv-space-1) var(--kv-space-2);
  background: transparent;
  color: var(--kv-diff-deleted-fg);
  border: none;
  border-radius: var(--kv-radius);
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  cursor: pointer;
}

.kv-push-menu-item:hover {
  background-color: var(--kv-row-hover-bg);
}

/* The one in-webview progress affordance for whichever `remote.run` is in flight (P6 judgment
   call 6's precedent — no `Notifications` port, D54) — a phase label, throttled to ~10/s
   host-side (OQ10), and the one cancel button every remote op shares, D50's table read forward
   into "enabled" vs "disabled-with-reason". */
.kv-remote-progress {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: 0 var(--kv-space-2);
  color: var(--kv-description-fg);
  font-size: 0.9em;
}

.kv-remote-progress-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.kv-remote-progress-spin {
  display: inline-block;
  animation: kv-remote-progress-spin 1.5s steps(30) infinite;
}

@keyframes kv-remote-progress-spin {
  100% {
    transform: rotate(360deg);
  }
}
</style>
