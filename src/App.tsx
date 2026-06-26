import React from 'react'
import { mdToHtml, htmlToMd } from './lib/markdown'
import { SAMPLE_README, SAMPLE_NOTES, SAMPLE_TODO } from './lib/samples'
import { newId } from './lib/id'
import { SEG_ON, SEG_OFF, TB_BTN, LABEL } from './ui/classes'
import type { FileDoc, Layout, Props, Side, State } from './types'

export default class App extends React.Component<Props, State> {
  static defaultProps: Props = {
    defaultTheme: 'light',
    defaultLayout: 'studio',
    accentColor: '#3b6df2',
    syncScroll: true,
  }

  taRef = React.createRef<HTMLTextAreaElement>()
  previewRef = React.createRef<HTMLDivElement>()
  previewScrollRef = React.createRef<HTMLDivElement>()
  private _lock = false
  private _pendingSel: { s: number; e: number } | null = null
  private _lastRenderedMd: string | null = null

  constructor(props: Props) {
    super(props)
    const layout: Layout =
      props.defaultLayout && ['studio', 'tabs', 'focus'].includes(props.defaultLayout)
        ? props.defaultLayout
        : 'studio'
    this.state = {
      files: [
        { id: 'f1', name: 'README.md', content: SAMPLE_README },
        { id: 'f2', name: 'notes.md', content: SAMPLE_NOTES },
        { id: 'f3', name: 'todo.md', content: SAMPLE_TODO },
      ],
      activeId: 'f1',
      md: SAMPLE_README,
      theme: props.defaultTheme === 'dark' ? 'dark' : 'light',
      layout,
      focusPane: 'edit',
      editingSide: 'init',
      dragOver: false,
    }
  }

  componentDidMount(): void {
    this.renderPreview()
  }

  componentDidUpdate(): void {
    if (this.state.editingSide !== 'right') {
      this.renderPreview()
    }
    if (this._pendingSel && this.taRef.current) {
      const p = this._pendingSel
      this._pendingSel = null
      const ta = this.taRef.current
      ta.focus()
      ta.setSelectionRange(p.s, p.e)
    }
  }

  /** Re-render the editable preview from markdown. Skips recompute when the
   * markdown is unchanged (e.g. theme/layout toggles re-render the tree). */
  renderPreview(): void {
    const el = this.previewRef.current
    if (!el) return
    if (this._lastRenderedMd === this.state.md) return
    this._lastRenderedMd = this.state.md
    const html = mdToHtml(this.state.md)
    if (el.innerHTML !== html) el.innerHTML = html
  }

  setMd(md: string, side: Side): void {
    this.setState((s) => ({
      md,
      editingSide: side,
      files: s.files.map((f) => (f.id === s.activeId ? { ...f, content: md } : f)),
    }))
  }

  onMdChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    this.setMd(e.currentTarget.value, 'left')
  }
  onPreviewInput = (e: React.FormEvent<HTMLDivElement>): void => {
    // Right-side edits own the DOM; mark it rendered so we don't clobber it.
    this._lastRenderedMd = null
    this.setMd(htmlToMd(e.currentTarget), 'right')
  }

  onTaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const s = ta.selectionStart
      const en = ta.selectionEnd
      const v = ta.value
      const nv = v.slice(0, s) + '  ' + v.slice(en)
      this._pendingSel = { s: s + 2, e: s + 2 }
      this.setMd(nv, 'left')
    }
  }

  wrap = (before: string, after?: string): void => {
    const close = after === undefined ? before : after
    const ta = this.taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const e = ta.selectionEnd
    const v = ta.value
    const sel = v.slice(s, e) || 'text'
    const nv = v.slice(0, s) + before + sel + close + v.slice(e)
    this._pendingSel = { s: s + before.length, e: s + before.length + sel.length }
    this.setMd(nv, 'left')
  }
  prefix = (pfx: string): void => {
    const ta = this.taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const v = ta.value
    const ls = v.lastIndexOf('\n', s - 1) + 1
    const cur = v.slice(ls)
    const stripped = cur.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, '')
    const nv = v.slice(0, ls) + pfx + stripped
    const delta = pfx.length - (cur.length - stripped.length)
    this._pendingSel = { s: Math.max(ls, s + delta), e: Math.max(ls, s + delta) }
    this.setMd(nv, 'left')
  }

  tbH1 = (): void => this.prefix('# ')
  tbH2 = (): void => this.prefix('## ')
  tbH3 = (): void => this.prefix('### ')
  tbBold = (): void => this.wrap('**')
  tbItalic = (): void => this.wrap('*')
  tbStrike = (): void => this.wrap('~~')
  tbCode = (): void => this.wrap('`')
  tbUl = (): void => this.prefix('- ')
  tbOl = (): void => this.prefix('1. ')
  tbQuote = (): void => this.prefix('> ')
  tbLink = (): void => this.wrap('[', '](https://)')

  switchFile = (id: string): void => {
    const f = this.state.files.find((x) => x.id === id)
    if (!f) return
    this.setState({ activeId: id, md: f.content, editingSide: 'init', focusPane: 'edit' })
  }
  addFile = (): void => {
    const n = this.state.files.length + 1
    const id = newId()
    const nf: FileDoc = { id, name: 'untitled-' + n + '.md', content: '# Untitled\n\n' }
    this.setState((s) => ({
      files: s.files.concat([nf]),
      activeId: id,
      md: nf.content,
      editingSide: 'init',
      focusPane: 'edit',
    }))
  }
  deleteFile = (id: string): void => {
    this.setState((s) => {
      let files = s.files.filter((f) => f.id !== id)
      if (files.length === 0) {
        files = [{ id: newId(), name: 'untitled.md', content: '# Untitled\n\n' }]
      }
      let active = s.activeId
      let md = s.md
      let side = s.editingSide
      if (id === s.activeId) {
        active = files[0].id
        md = files[0].content
        side = 'init'
      }
      return { files, activeId: active, md, editingSide: side }
    })
  }

  onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    if (!this.state.dragOver) this.setState({ dragOver: true })
  }
  onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) {
      this.setState({ dragOver: false })
    }
  }
  onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    this.setState({ dragOver: false })
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    if (!file) return
    const r = new FileReader()
    r.onload = (ev: ProgressEvent<FileReader>): void => {
      const id = newId()
      const nf: FileDoc = { id, name: file.name, content: String(ev.target?.result ?? '') }
      this.setState((s) => ({
        files: s.files.concat([nf]),
        activeId: id,
        md: nf.content,
        editingSide: 'init',
        focusPane: 'edit',
      }))
    }
    r.readAsText(file)
  }

  exportMd = (): void => {
    const name = this.activeName()
    const blob = new Blob([this.state.md], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  /** Render the active document into a hidden iframe and print it.
   * Uses srcdoc (no deprecated document.write, no popup to be blocked). */
  exportPdf = (): void => {
    const body = mdToHtml(this.state.md)
    const css =
      '--accent:#3b6df2;--code-bg:#f1f1ed;--border:#e7e7e2;--muted:#73736c;--fg:#1b1b19;--mono:ui-monospace,monospace;--sans:-apple-system,system-ui,sans-serif'
    const doc =
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
      this.activeName() +
      '</title><style>:root{' +
      css +
      '}body{font-family:var(--sans);max-width:720px;margin:48px auto;padding:0 28px;line-height:1.75;color:var(--fg)}img{max-width:100%}@media print{body{margin:0}}</style></head><body>' +
      body +
      '</body></html>'

    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    iframe.srcdoc = doc
    iframe.onload = () => {
      const win = iframe.contentWindow
      if (win) {
        win.focus()
        win.print()
      }
      setTimeout(() => iframe.remove(), 1000)
    }
    document.body.appendChild(iframe)
  }

  setStudio = (): void => this.setState({ layout: 'studio' })
  setTabs = (): void => this.setState({ layout: 'tabs' })
  setFocus = (): void => this.setState({ layout: 'focus' })
  setLight = (): void => this.setState({ theme: 'light' })
  setDark = (): void => this.setState({ theme: 'dark' })
  setPaneEdit = (): void => this.setState({ focusPane: 'edit' })
  setPanePreview = (): void => this.setState({ focusPane: 'preview', editingSide: 'init' })

  onEditorScroll = (e: React.UIEvent<HTMLTextAreaElement>): void => {
    if (this.props.syncScroll === false) return
    if (this._lock) {
      this._lock = false
      return
    }
    const t = e.currentTarget
    const p = this.previewScrollRef.current
    if (!p) return
    const r = t.scrollTop / Math.max(1, t.scrollHeight - t.clientHeight)
    this._lock = true
    p.scrollTop = r * (p.scrollHeight - p.clientHeight)
  }
  onPreviewScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    if (this.props.syncScroll === false) return
    if (this._lock) {
      this._lock = false
      return
    }
    const p = e.currentTarget
    const t = this.taRef.current
    if (!t) return
    const r = p.scrollTop / Math.max(1, p.scrollHeight - p.clientHeight)
    this._lock = true
    t.scrollTop = r * (t.scrollHeight - t.clientHeight)
  }

  activeName(): string {
    const f = this.state.files.find((x) => x.id === this.state.activeId)
    return f ? f.name : 'untitled.md'
  }

  /** Sidebar / tab row: a select button plus a sibling delete button.
   * Two distinct buttons (never nested) keeps it valid + keyboard-accessible. */
  private renderFileRow(f: FileDoc, variant: 'list' | 'tab') {
    const active = f.id === this.state.activeId
    const dot =
      'w-[7px] h-[7px] rounded-full shrink-0 ' +
      (active ? 'bg-[var(--accent)]' : 'bg-[var(--faint)]')
    const del =
      variant === 'list'
        ? 'shrink-0 px-[3px] mr-[6px] rounded-[4px] border-0 bg-transparent text-[var(--faint)] text-[15px] leading-none cursor-pointer opacity-60 hover:text-[var(--fg)] hover:opacity-100'
        : 'shrink-0 px-[2px] pr-[8px] rounded-[4px] border-0 bg-transparent text-[var(--faint)] text-[15px] leading-none cursor-pointer hover:text-[var(--fg)]'

    if (variant === 'list') {
      const wrap =
        'flex items-center my-[1px] rounded-[8px] font-medium text-[12.5px] leading-[1.3] font-mono transition-colors duration-[100ms] hover:bg-[var(--panel2)] ' +
        (active ? 'bg-[var(--panel)] text-[var(--fg)]' : 'text-[var(--muted)]')
      return (
        <li key={f.id} className={wrap}>
          <button
            type="button"
            onClick={() => this.switchFile(f.id)}
            aria-current={active ? 'true' : undefined}
            className="flex-1 min-w-0 flex items-center gap-[8px] px-[9px] py-[7px] bg-transparent border-0 cursor-pointer text-left text-inherit font-[inherit]"
          >
            <span aria-hidden="true" className={dot} />
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{f.name}</span>
          </button>
          <button
            type="button"
            onClick={() => this.deleteFile(f.id)}
            aria-label={`Delete ${f.name}`}
            title="Delete"
            className={del}
          >
            ×
          </button>
        </li>
      )
    }

    const wrap =
      'inline-flex items-center self-center h-[30px] rounded-[8px] font-medium text-[12.5px] leading-none font-mono shrink-0 transition-colors duration-[100ms] border ' +
      (active
        ? 'bg-[var(--panel2)] text-[var(--fg)] border-[var(--border)]'
        : 'text-[var(--muted)] border-transparent')
    return (
      <div key={f.id} className={wrap}>
        <button
          type="button"
          onClick={() => this.switchFile(f.id)}
          aria-current={active ? 'true' : undefined}
          className="flex items-center gap-[7px] pl-[12px] pr-[7px] h-full bg-transparent border-0 cursor-pointer text-inherit font-[inherit]"
        >
          <span aria-hidden="true" className={dot} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[160px]">
            {f.name}
          </span>
        </button>
        <button
          type="button"
          onClick={() => this.deleteFile(f.id)}
          aria-label={`Delete ${f.name}`}
          title="Delete"
          className={del}
        >
          ×
        </button>
      </div>
    )
  }

  render() {
    const st = this.state
    const { layout, theme } = st
    const isTabs = layout === 'tabs'
    const isFocus = layout === 'focus'
    const isStudio = layout === 'studio'

    // word / char / line counts
    const md = st.md || ''
    const plain = md
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~-]|\d+\.|\[|\]|\(.*?\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const words = plain ? plain.split(' ').length : 0
    const read = Math.max(1, Math.ceil(words / 200))

    const editorVisible = !isFocus || st.focusPane === 'edit'
    const previewVisible = !isFocus || st.focusPane === 'preview'
    const editorWrapClass =
      (editorVisible ? 'flex' : 'hidden') +
      ' flex-[1_1_0] min-w-0 flex-col border-r border-[var(--border)]'
    const previewWrapClass = (previewVisible ? 'flex' : 'hidden') + ' flex-[1_1_0] min-w-0 flex-col'

    const accent = this.props.accentColor || '#3b6df2'
    const rootStyle = { '--accent-color': accent, height: '100%' } as React.CSSProperties
    const syncLabel = this.props.syncScroll === false ? 'Sync scroll off' : 'Sync scroll on'

    return (
      <div data-theme={theme} style={rootStyle}>
        <div
          className="flex flex-col h-screen bg-[var(--bg)] text-[var(--fg)] font-sans relative"
          onDragOver={this.onDragOver}
          onDragLeave={this.onDragLeave}
          onDrop={this.onDrop}
        >
          {/* HEADER */}
          <header className="flex items-center gap-[16px] h-[52px] shrink-0 pl-[16px] pr-[14px] bg-[var(--panel)] border-b border-[var(--border)] z-[5]">
            <div className="flex items-center gap-[9px] min-w-0">
              <span
                aria-hidden="true"
                className="w-[13px] h-[13px] rounded-[3px] bg-[var(--accent)] shrink-0"
              />
              <span className="font-bold text-[14px] leading-none font-sans tracking-[-0.01em]">
                Markdown
              </span>
              <span aria-hidden="true" className="text-[var(--faint)] text-[13px]">
                /
              </span>
              <span className="font-medium text-[13px] leading-none font-mono text-[var(--muted)] overflow-hidden text-ellipsis whitespace-nowrap">
                {this.activeName()}
              </span>
            </div>

            <div className="flex-1" />

            {/* layout switcher */}
            <div
              role="group"
              aria-label="Layout"
              className="inline-flex gap-[2px] p-[3px] bg-[var(--panel2)] rounded-[9px] border border-[var(--border)]"
            >
              <button
                type="button"
                aria-pressed={isStudio}
                onClick={this.setStudio}
                className={isStudio ? SEG_ON : SEG_OFF}
              >
                Studio
              </button>
              <button
                type="button"
                aria-pressed={isTabs}
                onClick={this.setTabs}
                className={isTabs ? SEG_ON : SEG_OFF}
              >
                Tabs
              </button>
              <button
                type="button"
                aria-pressed={isFocus}
                onClick={this.setFocus}
                className={isFocus ? SEG_ON : SEG_OFF}
              >
                Focus
              </button>
            </div>

            {/* theme toggle */}
            <div
              role="group"
              aria-label="Theme"
              className="inline-flex gap-[2px] p-[3px] bg-[var(--panel2)] rounded-[9px] border border-[var(--border)]"
            >
              <button
                type="button"
                aria-pressed={theme === 'light'}
                onClick={this.setLight}
                className={theme === 'light' ? SEG_ON : SEG_OFF}
              >
                Light
              </button>
              <button
                type="button"
                aria-pressed={theme === 'dark'}
                onClick={this.setDark}
                className={theme === 'dark' ? SEG_ON : SEG_OFF}
              >
                Dark
              </button>
            </div>

            <div aria-hidden="true" className="w-px h-[24px] bg-[var(--border)]" />

            <button
              type="button"
              onClick={this.exportMd}
              className="inline-flex items-center gap-[6px] h-[32px] px-[12px] border border-[var(--border)] rounded-[8px] bg-[var(--panel)] text-[var(--fg)] font-medium text-[12.5px] leading-none font-sans cursor-pointer hover:bg-[var(--panel2)]"
            >
              .md
            </button>
            <button
              type="button"
              onClick={this.exportPdf}
              className="inline-flex items-center gap-[6px] h-[32px] px-[13px] border border-transparent rounded-[8px] bg-[var(--accent)] text-white font-semibold text-[12.5px] leading-none font-sans cursor-pointer hover:brightness-[1.07]"
            >
              Export PDF
            </button>
          </header>

          {/* TABS strip (Tabs layout) */}
          {isTabs && (
            <div className="flex items-stretch h-[40px] shrink-0 bg-[var(--panel)] border-b border-[var(--border)] px-[8px] gap-[2px] overflow-x-auto">
              {st.files.map((f) => this.renderFileRow(f, 'tab'))}
              <button
                type="button"
                onClick={this.addFile}
                aria-label="New file"
                title="New file"
                className="self-center ml-[4px] w-[26px] h-[26px] border border-dashed border-[var(--border)] rounded-[7px] bg-transparent text-[var(--muted)] text-[16px] leading-none cursor-pointer shrink-0 hover:text-[var(--fg)] hover:border-[var(--faint)]"
              >
                +
              </button>
            </div>
          )}

          {/* BODY */}
          <div className="flex-1 flex min-h-0 relative">
            {/* SIDEBAR */}
            {isStudio && (
              <aside
                aria-label="Files"
                className="w-[236px] shrink-0 flex flex-col bg-[var(--panel2)] border-r border-[var(--border)]"
              >
                <div className="flex items-center h-[42px] pl-[16px] pr-[14px] shrink-0">
                  <span className={'flex-1 ' + LABEL}>Files</span>
                  <button
                    type="button"
                    onClick={this.addFile}
                    aria-label="New file"
                    title="New file"
                    className="w-[24px] h-[24px] border-0 rounded-[6px] bg-transparent text-[var(--muted)] text-[17px] leading-none cursor-pointer hover:bg-[var(--panel)] hover:text-[var(--fg)]"
                  >
                    +
                  </button>
                </div>
                <ul role="list" className="flex-1 overflow-y-auto py-[4px] px-[8px] m-0 list-none">
                  {st.files.map((f) => this.renderFileRow(f, 'list'))}
                </ul>
                <div className="shrink-0 m-[8px] p-[12px] border border-dashed border-[var(--border)] rounded-[10px] text-center text-[var(--faint)] font-normal text-[11px] leading-[1.5] font-mono">
                  Drag a <span className="text-[var(--muted)]">.md</span> file
                  <br />
                  anywhere to import
                </div>
              </aside>
            )}

            {/* EDITOR + PREVIEW */}
            <div className="flex-1 flex min-h-0">
              {/* editor */}
              <section aria-label="Markdown source" className={editorWrapClass}>
                <div
                  role="toolbar"
                  aria-label="Formatting"
                  className="flex items-center gap-[3px] h-[42px] shrink-0 pl-[12px] pr-[8px] border-b border-[var(--border)] bg-[var(--panel)]"
                >
                  <span className={LABEL + ' mr-[6px]'}>Source</span>
                  <div aria-hidden="true" className="w-px h-[18px] bg-[var(--border)] mx-[4px]" />
                  <button
                    type="button"
                    onClick={this.tbH1}
                    aria-label="Heading 1"
                    title="Heading 1"
                    className={TB_BTN}
                  >
                    H1
                  </button>
                  <button
                    type="button"
                    onClick={this.tbH2}
                    aria-label="Heading 2"
                    title="Heading 2"
                    className={TB_BTN}
                  >
                    H2
                  </button>
                  <button
                    type="button"
                    onClick={this.tbH3}
                    aria-label="Heading 3"
                    title="Heading 3"
                    className={TB_BTN}
                  >
                    H3
                  </button>
                  <div aria-hidden="true" className="w-px h-[18px] bg-[var(--border)] mx-[4px]" />
                  <button
                    type="button"
                    onClick={this.tbBold}
                    aria-label="Bold"
                    title="Bold"
                    className={TB_BTN + ' font-bold'}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={this.tbItalic}
                    aria-label="Italic"
                    title="Italic"
                    className={TB_BTN + ' italic font-[Georgia,serif]'}
                  >
                    i
                  </button>
                  <button
                    type="button"
                    onClick={this.tbStrike}
                    aria-label="Strikethrough"
                    title="Strikethrough"
                    className={TB_BTN + ' line-through'}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    onClick={this.tbCode}
                    aria-label="Inline code"
                    title="Inline code"
                    className={TB_BTN + ' font-mono'}
                  >
                    {'</>'}
                  </button>
                  <div aria-hidden="true" className="w-px h-[18px] bg-[var(--border)] mx-[4px]" />
                  <button
                    type="button"
                    onClick={this.tbUl}
                    aria-label="Bullet list"
                    title="Bullet list"
                    className={TB_BTN}
                  >
                    •—
                  </button>
                  <button
                    type="button"
                    onClick={this.tbOl}
                    aria-label="Numbered list"
                    title="Numbered list"
                    className={TB_BTN}
                  >
                    1.
                  </button>
                  <button
                    type="button"
                    onClick={this.tbQuote}
                    aria-label="Quote"
                    title="Quote"
                    className={TB_BTN}
                  >
                    ”
                  </button>
                  <button
                    type="button"
                    onClick={this.tbLink}
                    aria-label="Link"
                    title="Link"
                    className={TB_BTN + ' px-[9px]'}
                  >
                    Link
                  </button>
                </div>
                <textarea
                  ref={this.taRef}
                  value={md}
                  onChange={this.onMdChange}
                  onScroll={this.onEditorScroll}
                  onKeyDown={this.onTaKey}
                  spellCheck={false}
                  aria-label="Markdown source"
                  placeholder="# Start typing Markdown..."
                  className="flex-1 w-full border-0 resize-none bg-[var(--panel)] text-[var(--fg)] py-[20px] px-[24px] text-[13.5px] leading-[1.75] font-mono outline-none [tab-size:2]"
                />
              </section>

              {/* preview */}
              <section aria-label="Preview" className={previewWrapClass}>
                <div className="flex items-center h-[42px] shrink-0 px-[16px] border-b border-[var(--border)] bg-[var(--panel)]">
                  <span className={'flex-1 ' + LABEL}>Preview · editable</span>
                  <span className="font-normal text-[11px] leading-none font-mono text-[var(--faint)]">
                    {read} min read
                  </span>
                </div>
                <div
                  ref={this.previewScrollRef}
                  onScroll={this.onPreviewScroll}
                  className="flex-1 overflow-y-auto bg-[var(--panel)]"
                >
                  <div
                    ref={this.previewRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={this.onPreviewInput}
                    spellCheck={false}
                    role="textbox"
                    aria-multiline="true"
                    aria-label="Rendered preview, editable"
                    className="max-w-[760px] mx-auto pt-[26px] px-[34px] pb-[90px] text-[var(--fg)] text-[15px] leading-[1.75] font-sans min-h-full [caret-color:var(--accent)]"
                  />
                </div>
              </section>

              {/* Focus pane switch */}
              {isFocus && (
                <div
                  role="group"
                  aria-label="Focus pane"
                  className="absolute left-1/2 bottom-[18px] -translate-x-1/2 inline-flex gap-[2px] p-[4px] bg-[var(--panel)] border border-[var(--border)] rounded-[11px] shadow-[0_6px_24px_rgba(0,0,0,0.16)] z-[6]"
                >
                  <button
                    type="button"
                    aria-pressed={st.focusPane === 'edit'}
                    onClick={this.setPaneEdit}
                    className={st.focusPane === 'edit' ? SEG_ON : SEG_OFF}
                  >
                    Write
                  </button>
                  <button
                    type="button"
                    aria-pressed={st.focusPane === 'preview'}
                    onClick={this.setPanePreview}
                    className={st.focusPane === 'preview' ? SEG_ON : SEG_OFF}
                  >
                    Read
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* STATUS BAR */}
          <footer className="flex items-center gap-[18px] h-[27px] shrink-0 px-[16px] bg-[var(--panel)] border-t border-[var(--border)] text-[11px] leading-none font-mono text-[var(--muted)]">
            <span aria-hidden="true" className="text-[var(--accent)]">
              ●
            </span>
            <span>{words} words</span>
            <span className="text-[var(--faint)]">{md.length} chars</span>
            <span className="text-[var(--faint)]">{md.split('\n').length} lines</span>
            <span className="flex-1" />
            <span className="text-[var(--faint)]">{syncLabel}</span>
            <span>Markdown</span>
          </footer>

          {/* DRAG OVERLAY */}
          {st.dragOver && (
            <div className="absolute inset-0 z-50 bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg))] flex items-center justify-center animate-[fadein_0.12s_ease]">
              <div className="p-[40px_56px] border-2 border-dashed border-[var(--accent)] rounded-[18px] bg-[var(--panel)] text-center">
                <div className="font-bold text-[20px] leading-[1.2] font-sans mb-[6px]">
                  Drop to import
                </div>
                <div className="font-normal text-[13px] leading-none font-mono text-[var(--muted)]">
                  .md · .markdown · .txt
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }
}
