/**
 * Extensions treated as editable documents.
 *
 * Its own module so both the resolver and the agent registry can use it without
 * one importing the other — resolve.ts imports agents.ts, so the constant cannot
 * live there.
 */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt'] as const
