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

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { NOTES_MAX_CHARS } from 'dsh-context-zip/engine/prompt';

/** Root of the plugin's on-disk state. */
export function contextZipRoot() {
  return dshHomePath('context-zip');
}

/** Directory holding every session's notes. */
export function notesRoot() {
  return join(contextZipRoot(), 'notes');
}

/** Directory holding exported segment markdown. */
export function exportsRoot() {
  return join(contextZipRoot(), 'exports');
}

/**
 * Make one session id safe to use as a single path segment.
 *
 * @param sessionId - raw session id.
 * @returns a path-safe name that stays recognizable.
 */
export function safeSessionName(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]/gu, '_');
  return cleaned.length === 0 ? 'session' : cleaned;
}

/** Zero-padded archive file name for one segment ordinal. */
export function segmentFileName(ordinal) {
  return `seg-${String(Math.max(0, ordinal | 0)).padStart(3, '0')}.md`;
}

/** Owns reading, appending, archiving, and exporting one plugin's notes. */
export class NoteStore {
  /** Root directory this store writes under. */
  root: string;

  /**
   * @param root - root directory this store writes under; injectable for tests.
   *   Omitted, the store uses the plugin's own notes directory.
   */
  constructor(root?: string) {
    this.root = root ?? notesRoot();
  }

  /** Absolute path of one session's live draft. */
  draftPath(sessionId) {
    return join(this.root, `${safeSessionName(sessionId)}.md`);
  }

  /** Absolute path of one session's archive directory. */
  archiveDir(sessionId) {
    return join(this.root, safeSessionName(sessionId));
  }

  /** Absolute path of one archived segment file. */
  archivePath(sessionId, ordinal) {
    return join(this.archiveDir(sessionId), segmentFileName(ordinal));
  }

  /**
   * Read one session's live draft.
   *
   * @param sessionId - session whose draft is read.
   * @returns the draft text, or '' when no draft exists.
   */
  async read(sessionId) {
    try {
      return await readFile(this.draftPath(sessionId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }

  /**
   * Append lines to one session's live draft, trimming the oldest content when
   * the single-file bound is exceeded.
   *
   * @param sessionId - session whose draft grows.
   * @param text - the model's note text.
   * @returns the stored character count and whether trimming happened.
   */
  async append(sessionId, text) {
    const existing = await this.read(sessionId);
    const entry = formatEntry(text);
    const next = existing.length === 0 ? entry : `${existing}\n${entry}`;
    const trimmed = trimToLimit(next, NOTES_MAX_CHARS);
    const path = this.draftPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, trimmed.text);
    // Which loss happened is not the same question as whether one did. With an
    // empty draft there was nothing older to drop, so a trim here means THIS entry
    // was cut, and reporting "older entries were dropped" would point the reader at
    // a loss that never occurred.
    // Two different losses can happen at once, and one boolean cannot report the
    // pair: older entries can be dropped AND the new entry can itself be too large
    // to survive whole. `entryCut` is measured rather than inferred, by asking
    // whether the entry this call appended is still present in full.
    return {
      chars: trimmed.text.length,
      trimmed: trimmed.trimmed,
      droppedOlder: trimmed.trimmed && existing.length > 0,
      entryCut: trimmed.trimmed && !trimmed.text.includes(entry),
    };
  }

  /**
   * Read one archived segment's notes.
   *
   * @param sessionId - session whose archive is read.
   * @param ordinal - segment ordinal the archive belongs to.
   * @returns the archived text, or '' when that segment kept no notes.
   */
  async readArchive(sessionId, ordinal) {
    try {
      return await readFile(this.archivePath(sessionId, ordinal), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }

  /**
   * Move the live draft into the archive under one segment ordinal.
   *
   * @param sessionId - session whose draft is archived.
   * @param ordinal - segment ordinal the draft belongs to.
   * @returns the archive path, or null when there was nothing to archive.
   */
  async archive(sessionId, ordinal) {
    const draft = await this.read(sessionId);
    if (draft.trim().length === 0) return null;
    const target = this.archivePath(sessionId, ordinal);
    await mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, draft);
    await rm(this.draftPath(sessionId), { force: true });
    return target;
  }

  /**
   * List the archived segment files of one session.
   *
   * @param sessionId - session whose archive is listed.
   * @returns file names in ascending order.
   */
  async listArchive(sessionId) {
    try {
      const names = await readdir(this.archiveDir(sessionId));
      return names.filter((name) => name.startsWith('seg-') && name.endsWith('.md')).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
}

/**
 * Format one note entry.
 *
 * @param text - raw note text from the model.
 * @returns a timestamped entry block.
 */
export function formatEntry(text) {
  const stamp = new Date().toISOString().slice(11, 16);
  const body = String(text).replace(/\s+$/u, '');
  return `- [${stamp}] ${body}`;
}

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
export function trimToLimit(text, limit) {
  if (text.length <= limit) return { text, trimmed: false };
  const marker = '[earlier notes dropped: per-session limit reached]\n';
  const lines = text.split('\n');
  while (lines.length > 1 && marker.length + lines.join('\n').length > limit) lines.shift();
  const body = lines.join('\n');
  return { text: `${marker}${body}`.slice(0, limit), trimmed: true };
}

/**
 * Write a file by renaming a sibling temporary over it.
 *
 * @param path - final path.
 * @param content - complete file content.
 */
export async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export default { NoteStore, notesRoot, exportsRoot, safeSessionName, segmentFileName, formatEntry, trimToLimit, atomicWrite };
