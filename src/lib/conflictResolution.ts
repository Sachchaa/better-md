/** What "take theirs" should do with a conflict. */
export type TakeTheirsOutcome = { kind: 'gone' } | { kind: 'apply'; content: string }

/**
 * A null `theirContent` means the document vanished from disk — there is no
 * "theirs" to take. Returning 'gone' rather than an empty string is the whole
 * point: applying '' would replace the user's text with nothing, which is data
 * loss dressed up as conflict resolution.
 */
export function decideTakeTheirs(theirContent: string | null): TakeTheirsOutcome {
  if (theirContent === null) return { kind: 'gone' }
  return { kind: 'apply', content: theirContent }
}

/**
 * True when a change notification describes our own write. The CLI watches the
 * workspace and notifies on any change, including the one this app just made,
 * so a save bounces an event straight back. If disk still carries the mtime we
 * loaded or last wrote, nothing moved and there is nothing to reload.
 */
export function isOwnEcho(
  diskMtimeMs: number | null,
  baseMtimeMs: number | null | undefined
): boolean {
  if (diskMtimeMs === null || baseMtimeMs === null || baseMtimeMs === undefined) return false
  return diskMtimeMs === baseMtimeMs
}
