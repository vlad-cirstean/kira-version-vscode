export type { GitCapabilities, RepoCapabilities } from "./capabilities.ts";
export { CapabilitiesCache, capabilitiesForVersion } from "./capabilities.ts";
export type { CatFileResult, CatFileSessionOptions } from "./catFile.ts";
export { DEFAULT_MAX_BLOB_BYTES, openCatFileSession } from "./catFile.ts";
export type {
  GitResolution,
  GitVersion,
  LocateGitOptions,
  RepoIdentityResolution,
  ResolvedGit,
} from "./discovery.ts";
export {
  compareVersions,
  locateGit,
  MINIMUM_GIT_VERSION,
  meetsMinimumVersion,
  parseGitVersion,
  resolveRepoIdentity,
} from "./discovery.ts";
export type {
  CatFileSession,
  Disposable,
  GitDriver,
  GitRead,
  GitWriteResult,
  OpenGitDriverOptions,
  ReadOptions,
  WriteOptions,
} from "./driver.ts";
export { buildGitArgv, buildGitEnv, openGitDriver } from "./driver.ts";
export type { GitErrorKind } from "./errors.ts";
export { classifyGitError, GitCancelled, GitError, GitSpawnFailed } from "./errors.ts";
export type { LogSession, LogSessionOptions, PageOutcome, ReadPageOptions } from "./logSession.ts";
export { openLogSession } from "./logSession.ts";
export { FileWatchError, NodeFileWatcher } from "./nodeFileWatcher.ts";
export { NodeProcessRunner, ProcessSpawnError } from "./nodeProcessRunner.ts";
export type { ParsedFileDiffBody } from "./parse/diff.ts";
export {
  fileDiffArgs,
  hasDeletedPostImage,
  parseFileDiffBody,
  worktreeDiffArgs,
} from "./parse/diff.ts";
export type { NameStatusEntry, NumstatEntry } from "./parse/diffTree.ts";
export {
  nameStatusArgs,
  numstatArgs,
  parseNameStatusRecords,
  parseNumstatRecords,
} from "./parse/diffTree.ts";
export type { LogArgsOptions } from "./parse/log.ts";
export {
  LOG_FORMAT,
  logArgs,
  logSessionArgs,
  logSessionSkipArgs,
  parseLogRecord,
  revSetArgs,
  showMetadataArgs,
} from "./parse/log.ts";
export { mergeTreeArgs, parseMergeTreeOutput } from "./parse/mergeTree.ts";
export {
  branchConfigRegexpArgs,
  branchCreateAndSwitchArgs,
  branchCreateArgs,
  branchDeleteArgs,
  branchRenameArgs,
  branchRevParseArgs,
} from "./ops/branch.ts";
export {
  rewrittenPathsArgs,
  switchArgs,
  switchCreateTrackingArgs,
  switchDetachArgs,
} from "./ops/checkout.ts";
export { abortArgs, continueArgs, readInProgressStateFiles } from "./ops/conflict.ts";
export { revertArgs } from "./ops/revert.ts";
export {
  tagCreateArgs,
  tagDeleteArgs,
  tagDeleteRemoteArgs,
  tagPushArgs,
  undoAnnotatedTagArgs,
  undoLightweightTagArgs,
} from "./ops/tag.ts";
export {
  parseRefRecord,
  REFS_FORMAT,
  REFS_RECORD_DELIMITER,
  refsArgs,
  TAG_REFS_FORMAT,
} from "./parse/refs.ts";
export { parseStashRecord, STASH_FORMAT, stashListArgs } from "./parse/stash.ts";
export { parseStatus, statusArgs } from "./parse/status.ts";
export type { CommitDetailOptions, LogQueryOptions, RefsSnapshot } from "./queries.ts";
export {
  commitDetail,
  countCommits,
  log,
  predictMerge,
  refs,
  refsSnapshot,
  revertMergeParents,
  stashList,
  status,
} from "./queries.ts";
export type {
  BlobResult,
  GitStatus,
  GraphChunkPayload,
  RepoOpenOutcome,
  RepoServiceDeps,
} from "./repoService.ts";
export {
  CHUNK_ROWS,
  DETAIL_CACHE_MAX_ENTRIES,
  DIFF_CACHE_MAX_BYTES,
  HIDDEN_EVICT_MS,
  MAX_PATCH_BYTES,
  RepoService,
} from "./repoService.ts";
export type { RepoHandlersDeps, RepoServicePort } from "./rpcHandlers.ts";
export { createRepoHandlers, createVirtualDocumentSource } from "./rpcHandlers.ts";
export type { RepoWatcher, WatchRepoOptions, WatchSignal } from "./watcher.ts";
export { watchRepo } from "./watcher.ts";
