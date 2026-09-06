export { advanceColorState, allocateColor, initialColorState } from "./graph/colors.ts";
export type { BuiltEdges } from "./graph/edges.ts";
export { EdgeBuffer } from "./graph/edges.ts";
export type { LaneAssignment } from "./graph/lanes.ts";
export { assignLanes } from "./graph/lanes.ts";
export type { LayoutAppendResult } from "./graph/layout.ts";
export { layoutAppend, layoutTransferList } from "./graph/layout.ts";
export type { StashRowFilter } from "./graph/stashRows.ts";
export { applyStashRowFilter, buildStashRowFilter } from "./graph/stashRows.ts";
export type {
  ColorState,
  EdgeKind,
  LayoutChunk,
  LayoutFrontier,
  LayoutInput,
  LayoutRequest,
  LayoutResponse,
  PendingEdge,
} from "./graph/types.ts";
export {
  DEFAULT_PALETTE_SIZE,
  EDGE_COLOR,
  EDGE_FROM_LANE,
  EDGE_FROM_ROW,
  EDGE_KIND,
  EDGE_KIND_BRANCH_OUT,
  EDGE_KIND_MERGE_IN,
  EDGE_KIND_STRAIGHT,
  EDGE_STRIDE,
  EDGE_TO_LANE,
  EDGE_TO_ROW,
  LANE_EMPTY,
  LANE_PENDING,
  UNRESOLVED_ROW,
} from "./graph/types.ts";
export type {
  CommitDetail,
  CommitIdentity,
  CommitRecord,
  CommitSignature,
  DecorationRef,
  FileChange,
  FileChangeKind,
  SignatureStatus,
} from "./model/commit.ts";
export type { MergePrediction, UnmergedEntry, UnmergedStage } from "./model/conflict.ts";
export type {
  CommitTrailer,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffRow,
  DiffSide,
  FileDiff,
  FileDiffBody,
} from "./model/diff.ts";
export {
  flattenDiffRows,
  mapDiffLineToRevision,
  mapLineAcrossDiff,
  splitTrailerBlock,
} from "./model/diff.ts";
export type {
  InProgressKind,
  InProgressOperation,
  InProgressStateFiles,
  OpErrorKind,
  OpRequest,
  OpResult,
  ResetMode,
  UndoSlotSnapshot,
} from "./model/operation.ts";
export { canRunOp, classifyInProgress, describeInProgress } from "./model/operation.ts";
export type { ProtectedBranchProblem, ProtectedMatch } from "./model/protectedBranch.ts";
export { matchProtectedBranch } from "./model/protectedBranch.ts";
export type { RefKind, RefRecord, RefTrack, TagAnnotation } from "./model/ref.ts";
export type {
  PullStrategy,
  PullStrategySource,
  RefUpdate,
  RemoteOpKind,
  RemoteOpRequest,
  RemoteOpResult,
} from "./model/remote.ts";
export type { HeadState, RepoIdentity } from "./model/repo.ts";
export type {
  BaseCandidate,
  BaseResolutionCore,
  BaseResolutionReason,
  ResolveBaseInput,
} from "./model/review.ts";
export { resolveBase } from "./model/review.ts";
export type { StashEntry } from "./model/stash.ts";
export type {
  FileStatusCode,
  IgnoredStatusEntry,
  OrdinaryStatusEntry,
  RenamedStatusEntry,
  StatusBranchInfo,
  StatusEntry,
  StatusResult,
  StatusSummary,
  UntrackedStatusEntry,
} from "./model/status.ts";
export { dirtyPathsFrom, summarizeStatus } from "./model/status.ts";
export { isAnnotated, tagTargetCommit } from "./model/tag.ts";
export type { Clipboard } from "./ports/clipboard.ts";
export type { CredentialPrompt, CredentialRequest } from "./ports/credentialPrompt.ts";
export type { Dialogs, PickFolderOptions } from "./ports/dialogs.ts";
export type { Disposable } from "./ports/disposable.ts";
export type {
  DocumentRef,
  EditorCapabilities,
  EditorIntegration,
  VirtualDocumentSource,
} from "./ports/editorIntegration.ts";
export type { FileWatchEvent, FileWatcher, FileWatchOptions } from "./ports/fileWatcher.ts";
export type { Logger, LogLevel } from "./ports/logger.ts";
export type {
  ProcessExit,
  ProcessRunner,
  SpawnedProcess,
  SpawnRequest,
} from "./ports/processRunner.ts";
export type { Storage, StorageScope } from "./ports/storage.ts";
export type { Theme, ThemeKind } from "./ports/theme.ts";
export type { RepoCandidate, WorkspaceRoots } from "./ports/workspaceRoots.ts";
export { classifyCheckout } from "./preflight/checkout.ts";
export { classifyCherryPick } from "./preflight/cherryPick.ts";
export type { PullConfigValues } from "./preflight/pull.ts";
export { buildPullPreflight, resolvePullStrategy } from "./preflight/pull.ts";
export { classifyPush } from "./preflight/push.ts";
export { classifyReset } from "./preflight/reset.ts";
export { classifyRevert } from "./preflight/revert.ts";
export { classifyStashBranch, classifyStashPop } from "./preflight/stashPop.ts";
export { classifyTagCreate, validateRefName } from "./preflight/tag.ts";
export type {
  CheckoutBlocker,
  CheckoutPreflight,
  CherryPickBlocker,
  CherryPickPreflight,
  DirtyPath,
  MergeOutcomePrediction,
  PullBlocker,
  PullPreflight,
  PullRoute,
  PushPreflight,
  ResetPreflight,
  RevertParentChoice,
  RevertPrediction,
  RevertPreflight,
  StashBranchPreflight,
  StashPopBlocker,
  StashPopPreflight,
  TagCreatePreflight,
} from "./preflight/types.ts";
export type {
  CoerceProblem,
  CoerceResult,
  HostKind,
  SettingDef,
  SettingKey,
  Settings,
  SettingType,
  SettingValue,
  VsCodeConfigurationSchema,
} from "./settings/schema.ts";
export {
  coerceSettings,
  defaultSettings,
  SETTINGS,
  toVsCodeConfiguration,
} from "./settings/schema.ts";
export type { AppendResult, CommitStoreStats, PackedCommitChunk } from "./store/commitStore.ts";
export { CommitStore, packedTransferList } from "./store/commitStore.ts";
export { StringInterner, SubjectBuffer } from "./store/intern.ts";
export type { ShaTableOptions } from "./store/shaTable.ts";
export { bytesToHex, hexToBytes, ShaTable } from "./store/shaTable.ts";
export type { UndoPolicy, UndoRecord } from "./undo/slot.ts";
export { UNDO_POLICY, UndoSlot } from "./undo/slot.ts";
export { AssertionError, assert, assertDefined, assertNever } from "./util/assert.ts";
export type { RecordSplitterOptions } from "./util/nulSplit.ts";
export {
  RecordSplitter,
  RemainderOverflowError,
  splitLimitedFields,
  splitRecords,
} from "./util/nulSplit.ts";
