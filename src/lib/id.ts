/** Generate a collision-free file id. Falls back to a random suffix when
 * `crypto.randomUUID` is unavailable (older/insecure-context browsers). */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'f_' + crypto.randomUUID()
  }
  return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}
