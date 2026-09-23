/**
 * Test entry: re-exports the internals the runtime checks exercise.
 *
 * It exists so `test/run.mjs` can import the BUILT plugin rather than the
 * TypeScript sources, which means a bundling mistake fails the checks too. It is
 * never referenced by the plugin itself.
 *
 * @module dsh-context-zip/test-entry
 */
export { attributeSummarySections, classifySummary, findUnsupportedClaims, auditUnsupportedClaims, fileOracleFromList, fileListFromMessages, sameFileSpelling, introducedPaths, pathTokensIn, rewriteGuardBlocks, messageVisibleText } from '../engine/engine.ts';
export { TOOL_RESULT_STORE_CEILING_CHARS, TOOL_RESULT_STORE_CEILING_BYTES, clampToStoreCeiling, utf8Bytes } from '../engine/prompt.ts';
export { searchNoteLines, historySearchTool, historyFindTool, historyReadTool, setThrottleEnabled, setThrottleListener, setTracePath } from '../src/tools.ts';
export {
  effectiveMode,
  resolveMode,
  resolveModeFrom,
  resolveRetrieval,
  resolveRetrievalFrom,
  rowOverrideFrom,
  sessionTitlesFor,
  userLayerFrom,
} from '../src/index.ts';
export { ContextZipService, exportFileName, registerExportCommand, renderSegmentMarkdown, sortBySeq } from '../src/export.ts';
export { deriveSegments, deriveTurnStart, segmentForSeq, loadSegments, ownHistoryStart, readSessionEvents, latestContextWindow } from '../src/segments.ts';
export { renderTranscript, renderWindow, renderEvent, locateAround,
  snapWindow, excerptAround, eventBody } from '../src/transcript.ts';
export { NoteStore, trimToLimit } from '../src/notes.ts';
export { buildSummarizationInstruction, createContextZipEngine, setSharedModeReader, summarizeTarget, setSharedFallbackReader, resetFailureStreaks, failureCount, isRangeTooSmallFailure, buildMechanicalSummary, messageVisibleText as packageMessageVisibleText } from 'dsh-context-zip/engine';
export { SUMMARY_HARD_CAP_TOKENS, SUMMARY_SOFT_TARGET_TOKENS, NOTES_MAX_CHARS  , SUMMARY_HEADINGS } from 'dsh-context-zip/engine/prompt';
export { buildRewriteInstruction } from 'dsh-context-zip/engine/prompt';
export { setSharedRewriteReader, lowestReasoningEffort, addedClaims, resolveRewriteRoute, runRewriteCall } from 'dsh-context-zip/engine';
export { PROBE_MAX_TOKENS, probeModel, readModelCatalog, requireRegisteredProvider } from '../src/models.ts';
export { SETTINGS_NS, applySettingsPatch } from '../src/index.ts';
export { registerRoutes } from '../src/routes.ts';
export {
  REDIRECT_PACKAGE,
  REDIRECT_MARKER,
  STAMP_FILE,
  assertPathInsideProfile,
  attentionKind,
  basePackageDir,
  importedSettingsPending,
  readAttention,
  readWireStatus,
  resolveProfileDirectory,
  wireCompactionRow,
} from '../src/wire.ts';
export { createTitleMemo, TITLE_TTL_MS } from '../src/session-titles.ts';
export { SESSION_KEY, isSessionKey } from '../src/session-key.ts';
export { LIVE_POLL_MS, LIVE_DEDUPE_MS, MODE_DEDUPE_MS, MODE_RETRY_SCHEDULE_MS, attentionOf, attentionPrompt, clockText, initialLiveHealth, liveHealthAfter, liveReadDue, mergeLivePayload, modeClickIntent, modeRetryDelay, rowsAfterSave, startLivePoll, startModeReadRetry, titlesFrom, toRows, SAVE_FEEDBACK_MS, sameSettings, saveButtonEnabled, saveButtonFace, stampText, wireFace, wireStatusFrom, wireText } from '../client/live.ts';
export {
  ManualTargetError,
  selectManualRange,
  planManualCompaction,
  failureReason,
  failureCountText,
  manualPlanText,
  manualDoneText,
  manualFailureText,
  registerManualCompactCommand,
  readFailureCount,
} from '../src/manual.ts';
