/**
 * Package entry for dsh-context-zip-engine.
 *
 * The class factory is exported beside the shared copy constants so the profile
 * redirect can build the engine over the shipped backend, and the plugin can
 * read the same prompt values without a second copy.
 *
 * @module dsh-context-zip-engine
 */
export { createContextZipEngine, buildSummarizationInstruction, runSummarizationCall, summarizeTarget, setSharedModeReader, setSharedNotesReader, setSharedFallbackReader, setSharedRewriteReader, resetFailureStreaks, failureCount, addManualCompactionSeat, hasManualCompactionSeat, runManualCompaction, resetManualCompactionSeats, buildMechanicalSummary, classifySummary, PLUGIN_ID, lowestReasoningEffort, addedClaims, resolveRewriteRoute, runRewriteCall, findUnsupportedClaims, auditUnsupportedClaims, fileOracleFromList, fileListFromMessages, sameFileSpelling, introducedPaths, pathTokensIn, rewriteGuardBlocks, messageVisibleText } from './engine.js';
export * from './prompt.js';
export { isRangeTooSmallFailure } from './failures.js';
export { default } from './engine.js';
