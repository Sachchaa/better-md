import type React from 'react'

interface ConflictBannerProps {
  fileName: string
  onKeepMine: () => void
  onTakeTheirs: () => void
}

export function ConflictBanner({
  fileName,
  onKeepMine,
  onTakeTheirs,
}: ConflictBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm"
      style={{ background: 'var(--code-bg)', borderColor: 'var(--border)' }}
    >
      <span>
        <strong>{fileName}</strong> changed on disk and you have unsaved edits.
      </span>
      <button type="button" onClick={onKeepMine} className="underline">
        Keep mine
      </button>
      <button type="button" onClick={onTakeTheirs} className="underline">
        Take theirs
      </button>
    </div>
  )
}

interface SaveErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function SaveErrorBanner({ message, onDismiss }: SaveErrorBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm"
      style={{ background: 'var(--code-bg)', borderColor: 'var(--border)' }}
    >
      <span>Could not save: {message}</span>
      <button type="button" onClick={onDismiss} className="underline">
        Dismiss
      </button>
    </div>
  )
}
