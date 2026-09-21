/**
 * Working-notes storage.
 *
 * Notes are the model's own draft of intent, constraints and plans. They live in
 * a plugin-owned directory under the harness home, so the plugin package itself
 * stays read-only and upgradeable, and they are archived rather than deleted
 * because "the notes were merged into a summary" has to stay reviewable.
 *
 * Layout:
 *
 * ```
 * <harness home>/context-zip/notes/<sessionId>.md          live draft
 * <harness home>/context-zip/notes/<sessionId>/seg-000.md  archive of one compaction
 * ```
 *
 * Every write goes through {@link NoteStore}: read-modify-write, then a temporary
 * file renamed over the target so a crash cannot leave a truncated draft behind.
 *
 * @module dsh-context-zip/notes
 */
/** Root of the plugin's on-disk state. */
export declare function contextZipRoot(): string;
/** Directory holding every session's notes. */
export declare function notesRoot(): string;
/** Directory holding exported segment markdown. */
export declare function exportsRoot(): string;
/**
 * Make one session id safe to use as a single path segment.
 *
 * @param sessionId - raw session id.
 * @returns a path-safe name that stays recognizable.
 */
export declare function safeSessionName(sessionId: any): string;
/** Zero-padded archive file name for one segment ordinal. */
export declare function segmentFileName(ordinal: any): string;
/** Owns reading, appending, archiving, and exporting one plugin's notes. */
export declare class NoteStore {
    /** Root directory this store writes under. */
    root: string;
    /**
     * @param root - root directory this store writes under; injectable for tests.
     *   Omitted, the store uses the plugin's own notes directory.
     */
    constructor(root?: string);
    /** Absolute path of one session's live draft. */
    draftPath(sessionId: any): string;
    /** Absolute path of one session's archive directory. */
    archiveDir(sessionId: any): string;
    /** Absolute path of one archived segment file. */
    archivePath(sessionId: any, ordinal: any): string;
    /**
     * Read one session's live draft.
     *
     * @param sessionId - session whose draft is read.
     * @returns the draft text, or '' when no draft exists.
     */
    read(sessionId: any): Promise<string>;
    /**
     * Append lines to one session's live draft, trimming the oldest content when
     * the single-file bound is exceeded.
     *
     * @param sessionId - session whose draft grows.
     * @param text - the model's note text.
     * @returns the stored character count and whether trimming happened.
     */
    append(sessionId: any, text: any): Promise<{
        chars: any;
        trimmed: boolean;
        droppedOlder: boolean;
        entryCut: boolean;
    }>;
    /**
     * Read one archived segment's notes.
     *
     * @param sessionId - session whose archive is read.
     * @param ordinal - segment ordinal the archive belongs to.
     * @returns the archived text, or '' when that segment kept no notes.
     */
    readArchive(sessionId: any, ordinal: any): Promise<string>;
    /**
     * Move the live draft into the archive under one segment ordinal.
     *
     * @param sessionId - session whose draft is archived.
     * @param ordinal - segment ordinal the draft belongs to.
     * @returns the archive path, or null when there was nothing to archive.
     */
    archive(sessionId: any, ordinal: any): Promise<string>;
    /**
     * List the archived segment files of one session.
     *
     * @param sessionId - session whose archive is listed.
     * @returns file names in ascending order.
     */
    listArchive(sessionId: any): Promise<string[]>;
}
/**
 * Format one note entry.
 *
 * @param text - raw note text from the model.
 * @returns a timestamped entry block.
 */
export declare function formatEntry(text: any): string;
/**
 * Bound a draft to a character limit, dropping the OLDEST entries first.
 *
 * A bounded draft is what keeps the notes from becoming a second transcript; the
 * marker line records that the bound did its job rather than losing text
 * silently.
 *
 * @param text - the candidate draft.
 * @param limit - maximum characters to keep.
 * @returns the bounded text and whether anything was dropped.
 */
export declare function trimToLimit(text: any, limit: any): {
    text: any;
    trimmed: boolean;
};
/**
 * Write a file by renaming a sibling temporary over it.
 *
 * @param path - final path.
 * @param content - complete file content.
 */
export declare function atomicWrite(path: any, content: any): Promise<void>;
declare const _default: {
    NoteStore: typeof NoteStore;
    notesRoot: typeof notesRoot;
    exportsRoot: typeof exportsRoot;
    safeSessionName: typeof safeSessionName;
    segmentFileName: typeof segmentFileName;
    formatEntry: typeof formatEntry;
    trimToLimit: typeof trimToLimit;
    atomicWrite: typeof atomicWrite;
};
export default _default;
