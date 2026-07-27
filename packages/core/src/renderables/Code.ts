import { type LineInfo, type RenderContext } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { getTreeSitterClient, TreeSitterClient } from "../lib/tree-sitter/index.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import type { TextChunk } from "../text-buffer.js"
import { treeSitterToTextChunks } from "../lib/tree-sitter-styled-text.js"

export interface HighlightContext {
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
}

export type OnHighlightCallback = (
  highlights: SimpleHighlight[],
  context: HighlightContext,
) => SimpleHighlight[] | undefined | Promise<SimpleHighlight[] | undefined>

export interface ChunkRenderContext extends HighlightContext {
  highlights: SimpleHighlight[]
}

export type OnChunksCallback = (
  chunks: TextChunk[],
  context: ChunkRenderContext,
) => TextChunk[] | undefined | Promise<TextChunk[] | undefined>

export interface HighlightErrorEvent {
  error: Error
  content: string
  filetype: string
}

type HighlightSnapshot = {
  id: number
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
  treeSitterClient: TreeSitterClient
  conceal: boolean
  drawUnstyledText: boolean
  streaming: boolean
  initialStyledText?: StyledText
  baseHighlight?: string
  onHighlight?: OnHighlightCallback
  onChunks?: OnChunksCallback
}

type MarkdownHighlightCache = {
  content: string
  cut: number
  frontmatterState: number
  highlights: SimpleHighlight[]
}

type MarkdownHighlightResult = {
  highlights: SimpleHighlight[]
  cache: MarkdownHighlightCache
}

export interface CodeOptions extends TextBufferOptions {
  content?: string
  filetype?: string
  syntaxStyle: SyntaxStyle
  treeSitterClient?: TreeSitterClient
  conceal?: boolean
  drawUnstyledText?: boolean
  streaming?: boolean
  initialStyledText?: StyledText
  baseHighlight?: string
  onHighlight?: OnHighlightCallback
  onChunks?: OnChunksCallback
}

type ConcealLineRange = [start: number, end: number]

export class CodeRenderable extends TextBufferRenderable {
  private _content: string
  private _filetype?: string
  private _syntaxStyle: SyntaxStyle
  private _isHighlighting: boolean = false
  private _highlightAbortController?: AbortController
  private _markdownHighlightCache?: MarkdownHighlightCache
  private _treeSitterClient: TreeSitterClient
  private _highlightUnavailable: boolean = false
  private _highlightsDirty: boolean = false
  private _highlightSnapshotId: number = 0
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _initialStyledText?: StyledText
  private _hadInitialContent: boolean = false
  private _baseHighlight?: string
  private _onHighlight?: OnHighlightCallback
  private _onChunks?: OnChunksCallback
  private _highlightingPromise: Promise<void> = Promise.resolve()
  // Temporary rendered-line -> source-line map for concealment; native extmarks should replace this.
  private _renderedLineSources?: number[]
  private _mappedLineInfo?: LineInfo

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    drawUnstyledText: true,
    streaming: false,
  } satisfies Partial<CodeOptions>

  constructor(ctx: RenderContext, options: CodeOptions) {
    super(ctx, options)

    this._content = options.content ?? this._contentDefaultOptions.content
    this._filetype = options.filetype
    this._syntaxStyle = options.syntaxStyle
    this._treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
    this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
    this._drawUnstyledText = options.drawUnstyledText ?? this._contentDefaultOptions.drawUnstyledText
    this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
    this._initialStyledText = options.initialStyledText
    this._baseHighlight = options.baseHighlight
    this._onHighlight = options.onHighlight
    this._onChunks = options.onChunks

    if (this._content.length > 0) {
      if (this._initialStyledText && this._drawUnstyledText) {
        this.textBuffer.setStyledText(this._initialStyledText)
      } else {
        this.textBuffer.setText(this._content)
      }
      this.updateTextInfo()
      this._shouldRenderTextBuffer = this._drawUnstyledText || !this._filetype
    }

    this._highlightsDirty = this._content.length > 0
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this._content !== value) {
      const appendOnly = value.startsWith(this._content)
      this._content = value
      this.invalidateHighlight(appendOnly)

      if (this._streaming && this._filetype && !this._drawUnstyledText) {
        return
      }

      if (this._initialStyledText && this._drawUnstyledText) {
        this.textBuffer.setStyledText(this._initialStyledText)
      } else {
        this.textBuffer.setText(value)
      }
      this.setRenderedLineSources(undefined)
      this.updateTextInfo()
    }
  }

  public override get lineInfo(): LineInfo {
    if (!this._renderedLineSources) return super.lineInfo
    if (this._mappedLineInfo) return this._mappedLineInfo

    const lineInfo = super.lineInfo
    const renderedLineSources = this._renderedLineSources

    // Native reports visual rows for the rendered buffer; remap those rows back to source lines.
    this._mappedLineInfo = {
      ...lineInfo,
      lineSources: lineInfo.lineSources.map((line) => renderedLineSources[line] ?? line),
    }
    return this._mappedLineInfo
  }

  public override get wrapMode(): "none" | "char" | "word" {
    return super.wrapMode
  }

  public override set wrapMode(value: "none" | "char" | "word") {
    if (super.wrapMode !== value) {
      this._mappedLineInfo = undefined
      super.wrapMode = value
    }
  }

  protected override onResize(width: number, height: number): void {
    this._mappedLineInfo = undefined
    super.onResize(width, height)
  }

  protected override updateTextInfo(): void {
    this._mappedLineInfo = undefined
    super.updateTextInfo()
  }

  get filetype(): string | undefined {
    return this._filetype
  }

  set filetype(value: string | undefined) {
    if (this._filetype !== value) {
      this._filetype = value
      this.invalidateHighlight()
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this.invalidateHighlight()
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.invalidateHighlight()
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      this.invalidateHighlight()
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set initialStyledText(value: StyledText | undefined) {
    if (this._initialStyledText !== value) {
      this._initialStyledText = value
      this.invalidateHighlight()
    }
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      this._hadInitialContent = false
      this.invalidateHighlight()
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      this._treeSitterClient = value
      this.invalidateHighlight()
    }
  }

  get onHighlight(): OnHighlightCallback | undefined {
    return this._onHighlight
  }

  get baseHighlight(): string | undefined {
    return this._baseHighlight
  }

  set baseHighlight(value: string | undefined) {
    if (this._baseHighlight !== value) {
      this._baseHighlight = value
      this.invalidateHighlight()
    }
  }

  set onHighlight(value: OnHighlightCallback | undefined) {
    if (this._onHighlight !== value) {
      this._onHighlight = value
      this.invalidateHighlight()
    }
  }

  get onChunks(): OnChunksCallback | undefined {
    return this._onChunks
  }

  set onChunks(value: OnChunksCallback | undefined) {
    if (this._onChunks !== value) {
      this._onChunks = value
      this.invalidateHighlight()
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting
  }

  get highlightUnavailable(): boolean {
    return this._highlightUnavailable
  }

  get highlightingDone(): Promise<void> {
    return this._highlightingPromise
  }

  private invalidateHighlight(preserveMarkdownCache = false): void {
    this._highlightUnavailable = false
    this._highlightsDirty = true
    this._highlightSnapshotId++
    if (!preserveMarkdownCache) {
      this._markdownHighlightCache = undefined
    }
    this._highlightAbortController?.abort()
    this.requestRender()
  }

  private captureHighlightSnapshot(): HighlightSnapshot {
    return {
      id: this._highlightSnapshotId,
      content: this._content,
      filetype: this._filetype ?? "",
      syntaxStyle: this._syntaxStyle,
      treeSitterClient: this._treeSitterClient,
      conceal: this._conceal,
      drawUnstyledText: this._drawUnstyledText,
      streaming: this._streaming,
      initialStyledText: this._initialStyledText,
      baseHighlight: this._baseHighlight,
      onHighlight: this._onHighlight,
      onChunks: this._onChunks,
    }
  }

  private isCurrentSnapshot(snapshot: HighlightSnapshot): boolean {
    return !this.isDestroyed && snapshot.id === this._highlightSnapshotId
  }

  protected async transformChunks(
    chunks: TextChunk[],
    context: ChunkRenderContext,
    onChunks?: OnChunksCallback,
  ): Promise<TextChunk[]> {
    if (!onChunks) return chunks

    const modified = await onChunks(chunks, context)
    return modified ?? chunks
  }

  private ensureVisibleTextBeforeHighlight(): void {
    if (this.isDestroyed) return

    const content = this._content

    if (!this._filetype) {
      this._shouldRenderTextBuffer = true
      return
    }

    const isInitialContent = this._streaming && !this._hadInitialContent
    const shouldDrawUnstyledNow = this._streaming ? isInitialContent && this._drawUnstyledText : this._drawUnstyledText

    if (this._streaming && !isInitialContent) {
      this._shouldRenderTextBuffer = true
    } else if (shouldDrawUnstyledNow) {
      if (this._initialStyledText) {
        this.textBuffer.setStyledText(this._initialStyledText)
      } else {
        this.textBuffer.setText(content)
      }
      this.setRenderedLineSources(undefined)
      this._shouldRenderTextBuffer = true
    } else {
      this._shouldRenderTextBuffer = false
    }
  }

  private async startHighlight(): Promise<void> {
    const snapshot = this.captureHighlightSnapshot()

    if (!snapshot.filetype) return

    const isInitialContent = snapshot.streaming && !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true
    const abortController = new AbortController()
    this._highlightAbortController = abortController

    try {
      const markdownResult = snapshot.streaming && snapshot.filetype === "markdown"
        ? await this.highlightMarkdown(snapshot, abortController.signal)
        : undefined
      const result = markdownResult ?? (await this.highlightWithAbort(snapshot, abortController.signal))

      if (!this.isCurrentSnapshot(snapshot)) {
        this.requestRender()
        return
      }

      if (markdownResult) {
        this._markdownHighlightCache = markdownResult.cache
      }

      let highlights = clipHighlights(result.highlights ?? [], snapshot.content.length)

      if (snapshot.onHighlight && highlights.length >= 0) {
        const context: HighlightContext = {
          content: snapshot.content,
          filetype: snapshot.filetype,
          syntaxStyle: snapshot.syntaxStyle,
        }
        const modified = await snapshot.onHighlight(highlights, context)
        if (!this.isCurrentSnapshot(snapshot)) {
          this.requestRender()
          return
        }
        if (modified !== undefined) {
          highlights = modified
        }
      }

      if (!this.isCurrentSnapshot(snapshot)) {
        this.requestRender()
        return
      }

      if (highlights.length > 0 || snapshot.onChunks || snapshot.baseHighlight) {
        const context: ChunkRenderContext = {
          content: snapshot.content,
          filetype: snapshot.filetype,
          syntaxStyle: snapshot.syntaxStyle,
          highlights,
        }

        let chunks = treeSitterToTextChunks(snapshot.content, highlights, snapshot.syntaxStyle, {
          enabled: snapshot.conceal,
          baseHighlight: snapshot.baseHighlight,
        })
        // onChunks may rewrite text arbitrarily, so the conceal-only source map would be invalid.
        const renderedLineSources = snapshot.onChunks
          ? undefined
          : this.getConcealLinesSourceMap(snapshot.content, highlights)

        chunks = await this.transformChunks(chunks, context, snapshot.onChunks)

        if (!this.isCurrentSnapshot(snapshot)) {
          this.requestRender()
          return
        }

        const styledText = new StyledText(chunks)
        this.textBuffer.setStyledText(styledText)
        this.setRenderedLineSources(renderedLineSources)
      } else {
        this.textBuffer.setText(snapshot.content)
        this.setRenderedLineSources(undefined)
      }

      this._shouldRenderTextBuffer = true
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } catch (error) {
      if (error instanceof Error && error.name === "TreeSitterWorkerTerminationError") {
        // 终止失败不能把原文伪装成高亮成功；新快照到达前保持不可用并暂停自动重试。
        this.markHighlightUnavailable(error)
        return
      }

      if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.requestRender()
        return
      }

      if (!this.isCurrentSnapshot(snapshot)) {
        this.requestRender()
        return
      }

      console.warn("Code highlighting failed, falling back to plain text:", error)
      this.textBuffer.setText(snapshot.content)
      this.setRenderedLineSources(undefined)
      this._shouldRenderTextBuffer = true
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } finally {
      if (this._highlightAbortController === abortController) {
        this._highlightAbortController = undefined
      }
      this._isHighlighting = false
      if (this._highlightsDirty && !this._highlightUnavailable && !this.isDestroyed) {
        this.requestRender()
        queueMicrotask(() => {
          if (!this._isHighlighting && this._highlightsDirty && !this.isDestroyed) {
            this.startDirtyHighlight()
          }
        })
      }
    }
  }

  private markHighlightUnavailable(error: Error): void {
    if (this.isDestroyed) return

    const shouldNotify = !this._highlightUnavailable
    this._highlightUnavailable = true
    this._highlightsDirty = true
    this.textBuffer.setText("Highlight unavailable")
    this.setRenderedLineSources(undefined)
    this._shouldRenderTextBuffer = true
    this.updateTextInfo()
    if (shouldNotify) {
      console.error("Code highlighting unavailable after worker termination failed:", error)
      this.emit("highlight-error", {
        error,
        content: this._content,
        filetype: this._filetype ?? "",
      } satisfies HighlightErrorEvent)
    }
    this.requestRender()
  }

  private async highlightMarkdown(snapshot: HighlightSnapshot, signal: AbortSignal): Promise<MarkdownHighlightResult> {
    const content = snapshot.content
    const frontmatterState = getFrontmatterState(content)
    const previous = this._markdownHighlightCache
    const canReuse =
      previous && content.startsWith(previous.content) && previous.frontmatterState === frontmatterState && stablePrefixEnd(content) >= previous.cut

    let cachedCut = canReuse ? previous.cut : 0
    let cachedHighlights = canReuse ? previous.highlights : []
    const cut = stablePrefixEnd(content)

    if (cut > cachedCut) {
      const segment = await this.highlightMarkdownFragment(snapshot, signal, content.slice(cachedCut, cut))
      cachedHighlights = cachedHighlights.concat(shiftHighlights(segment, cachedCut))
      cachedCut = cut
    }

    const tail = content.slice(cachedCut)
    const tailHighlights = tail.length === 0 ? [] : await this.highlightMarkdownFragment(snapshot, signal, tail)

    return {
      highlights: cachedHighlights.concat(shiftHighlights(tailHighlights, cachedCut)),
      cache: {
        content,
        cut: cachedCut,
        frontmatterState,
        highlights: cachedHighlights,
      },
    }
  }

  private async highlightMarkdownFragment(snapshot: HighlightSnapshot, signal: AbortSignal, content: string) {
    const parseContent = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content
    const result = await this.highlightWithAbort({ ...snapshot, content: parseContent }, signal)
    return clipHighlights(result.highlights ?? [], content.length)
  }

  private highlightWithAbort(snapshot: HighlightSnapshot, signal: AbortSignal) {
    // 取消结果由TreeSitterClient的worker生命周期owner返回，才能区分正常Abort和终止失败。
    return snapshot.treeSitterClient.highlightOnce(snapshot.content, snapshot.filetype, signal)
  }

  private setRenderedLineSources(lineSources: number[] | undefined): void {
    this._renderedLineSources = lineSources
    this._mappedLineInfo = undefined
  }

  private static isIdentityLineSources(lineSources: number[]): boolean {
    for (let i = 0; i < lineSources.length; i++) {
      if (lineSources[i] !== i) return false
    }
    return true
  }

  private static getMergedConcealLineRanges(highlights: SimpleHighlight[]): ConcealLineRange[] {
    const ranges: ConcealLineRange[] = []

    for (const highlight of highlights) {
      const meta = highlight[3]
      if (meta?.concealLines === undefined) continue

      const group = highlight[2]
      const isEmptyConceal =
        meta.conceal === "" || (meta.conceal === undefined && (group === "conceal" || group.startsWith("conceal.")))
      if (isEmptyConceal) {
        ranges.push([highlight[0], highlight[1]])
      }
    }

    if (ranges.length <= 1) return ranges

    // Overlapping conceal ranges must collapse before line-by-line source mapping.
    ranges.sort((a, b) => a[0] - b[0])
    let writeIndex = 0

    for (let i = 1; i < ranges.length; i++) {
      const current = ranges[writeIndex]
      const next = ranges[i]

      if (next[0] <= current[1]) {
        current[1] = Math.max(current[1], next[1])
      } else {
        writeIndex++
        ranges[writeIndex] = next
      }
    }

    ranges.length = writeIndex + 1
    return ranges
  }

  private getConcealLinesSourceMap(content: string, highlights: SimpleHighlight[]): number[] | undefined {
    if (!this._conceal || content.length === 0) return undefined

    // setStyledText gives native only rendered text; rebuild enough source identity for concealed lines.
    // Native view-resolved extmarks should make this a layout query instead of a parallel map.
    const concealLineRanges = CodeRenderable.getMergedConcealLineRanges(highlights)
    if (concealLineRanges.length === 0) return undefined

    const lineSources: number[] = []
    let sourceLine = 0
    let lineStart = 0
    let rangeIndex = 0
    let currentRenderedLineHasText = false

    const setCurrentRenderedLineSource = (line: number, hasText: boolean): void => {
      // Until visible text is emitted, a rendered line can still map to a later collapsed source line.
      if (lineSources.length === 0) {
        lineSources.push(line)
      } else if (!currentRenderedLineHasText) {
        lineSources[lineSources.length - 1] = line
      }

      if (hasText) currentRenderedLineHasText = true
    }

    while (lineStart <= content.length) {
      const newlineOffset = content.indexOf("\n", lineStart)
      const lineEnd = newlineOffset === -1 ? content.length : newlineOffset

      while (rangeIndex < concealLineRanges.length && concealLineRanges[rangeIndex][1] <= lineStart) {
        rangeIndex++
      }

      const range = concealLineRanges[rangeIndex]
      const fullyConcealed = !!range && lineEnd > lineStart && range[0] <= lineStart && range[1] >= lineEnd
      const lineBreakConcealed =
        newlineOffset !== -1 && !!range && range[0] <= newlineOffset && range[1] >= newlineOffset

      if (!fullyConcealed || !lineBreakConcealed) {
        const hasText = lineEnd > lineStart && !fullyConcealed
        if (hasText || newlineOffset !== -1 || !fullyConcealed) {
          setCurrentRenderedLineSource(sourceLine, hasText)
        }

        if (newlineOffset !== -1 && !lineBreakConcealed) {
          lineSources.push(sourceLine + 1)
          currentRenderedLineHasText = false
        }
      }

      sourceLine++
      if (newlineOffset === -1) break
      lineStart = newlineOffset + 1
    }

    if (lineSources.length === 0 || CodeRenderable.isIdentityLineSources(lineSources)) return undefined
    return lineSources
  }

  public getLineHighlights(lineIdx: number) {
    return this.textBuffer.getLineHighlights(lineIdx)
  }

  private startDirtyHighlight(): void {
    if (this.isDestroyed || this._isHighlighting || this._highlightUnavailable || !this._highlightsDirty) return

    if (this._content.length === 0) {
      this._shouldRenderTextBuffer = false
      this._highlightsDirty = false
      return
    }

    if (!this._filetype) {
      this._shouldRenderTextBuffer = true
      this._highlightsDirty = false
      return
    }

    this.ensureVisibleTextBeforeHighlight()
    this._highlightsDirty = false
    this._highlightingPromise = this.startHighlight()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._highlightsDirty) {
      if (this.isDestroyed) return

      if (this._isHighlighting) {
        // 先保留最新dirty snapshot；旧请求终止后由同一owner继续，避免并行worker/native提交。
      } else {
        this.startDirtyHighlight()
      }
    }

    if (!this._shouldRenderTextBuffer) return
    super.renderSelf(buffer)
  }
}

function shiftHighlights(highlights: SimpleHighlight[], offset: number): SimpleHighlight[] {
  if (offset === 0) return highlights
  return highlights.map((highlight) => [highlight[0] + offset, highlight[1] + offset, highlight[2], highlight[3]])
}

function clipHighlights(highlights: SimpleHighlight[], length: number): SimpleHighlight[] {
  return highlights.flatMap((highlight) => {
    if (highlight[0] >= length) return []
    if (highlight[1] <= length) return [highlight]
    return [[highlight[0], length, highlight[2], highlight[3]]]
  })
}

function stablePrefixEnd(content: string): number {
  const lines = content.split("\n")
  let offset = 0
  let lastSafe = 0
  let openFence = false
  let fenceMarker = ""

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineStart = offset
    offset += line.length + 1
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)

    if (openFence) {
      if (fenceMatch && fenceMatch[1][0] === fenceMarker[0] && fenceMatch[1].length >= fenceMarker.length) {
        openFence = false
        fenceMarker = ""
      }
      continue
    }

    if (fenceMatch) {
      openFence = true
      fenceMarker = fenceMatch[1]
      continue
    }

    if (hasReferenceUsage(line)) {
      // 后续 definition仍可能改变此行语义，usage所在行及之后必须留在完整上下文tail。
      return lastSafe
    }

    if (trimmed === "" && index !== lines.length - 1) {
      lastSafe = Math.min(content.length, lineStart + line.length + 1)
    }
  }

  if (openFence) {
    const previousBlank = content.lastIndexOf("\n\n")
    const fenceStart = findOpenFenceStart(content)
    let rollback = previousBlank === -1 ? 0 : previousBlank + 2
    if (rollback > fenceStart) {
      const earlierBlank = content.lastIndexOf("\n\n", Math.max(0, fenceStart - 1))
      rollback = earlierBlank === -1 ? 0 : earlierBlank + 2
    }
    lastSafe = Math.min(lastSafe, rollback)
  }

  const frontmatterState = getFrontmatterState(content)
  if (frontmatterState >= 0) {
    if (frontmatterState === 0) return 0
    return Math.max(frontmatterState, lastSafe >= frontmatterState ? lastSafe : frontmatterState)
  }

  return lastSafe
}

function hasReferenceUsage(line: string): boolean {
  if (/^\s{0,3}\[[^\]\n]+\]:/.test(line)) return false

  const match = /!?\[[^\]\n]+\](?:\[[^\]\n]*\])?/.exec(line)
  if (!match) return false

  const next = line[match.index + match[0].length]
  return next !== "(" && next !== ":"
}

function findOpenFenceStart(content: string): number {
  const lines = content.split("\n")
  let offset = 0
  let openAt = -1
  let marker = ""

  for (const line of lines) {
    const start = offset
    offset += line.length + 1
    const match = line.trim().match(/^(`{3,}|~{3,})/)
    if (!match) continue
    if (openAt === -1) {
      openAt = start
      marker = match[1]
    } else if (match[1][0] === marker[0] && match[1].length >= marker.length) {
      openAt = -1
      marker = ""
    }
  }

  return openAt === -1 ? content.length : openAt
}

function getFrontmatterState(content: string): number {
  const marker = content.match(/^(---|\+\+\+)\s*(\n|$)/)?.[1]
  if (!marker) return -1

  const lines = content.split("\n")
  let offset = lines[0].length + 1
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === marker) return Math.min(content.length, offset + line.length + 1)
    offset += line.length + 1
  }

  return 0
}
