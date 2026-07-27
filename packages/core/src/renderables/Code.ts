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
  // `content` 是最近真正解析的快照；boundary 可以领先到尚未解析的最新 append。
  // 两者分离后，deferred 状态不会把旧 highlights 冒充成新结果。
  content: string
  cut: number
  frontmatterState: number
  highlights: SimpleHighlight[]
  boundary: MarkdownBoundaryState
  parsedLength: number
  parsedLines: number
  parsedFenceStart?: number
}

type MarkdownBoundaryState = {
  // scanOffset 指向最后一个未闭合行的起点，下一次 append 只重扫该行和新增后缀。
  // lineCount 只统计完整行，partial closer 不得提前解除 deferred 状态。
  contentLength: number
  scanOffset: number
  lineCount: number
  lastSafe: number
  referenceBlocked: boolean
  frontmatterMarker?: "---" | "+++"
  frontmatterEnd?: number
  openFenceStart?: number
  fenceMarker?: string
  fenceRollback?: number
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

const OPEN_FENCE_BATCH_LINES = 32
const OPEN_FENCE_BATCH_CHARS = 4096
// 两个门槛取先到者：短行代码受字符上限保护，普通代码则每32行校正一次完整语义。
// 不使用定时器，避免空闲帧反复唤醒；fence closure和语义变更仍会立即绕过批量门槛。

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
      const coalesceAppend = appendOnly && this._streaming && this._filetype === "markdown"
      this._content = value
      if (coalesceAppend && this._markdownHighlightCache) {
        // 边界游标只消费新增后缀，避免长 fence 每个 delta 都同步扫描全部历史。
        // rewrite 不会进入这里，因此复用的 cursor 必然仍对应同一份 Markdown 前缀。
        this._markdownHighlightCache.boundary = advanceMarkdownBoundary(value, this._markdownHighlightCache.boundary)
      }
      this.invalidateHighlight(appendOnly, !coalesceAppend)

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

  private invalidateHighlight(preserveMarkdownCache = false, abortActive = true): void {
    this._highlightUnavailable = false
    this._highlightsDirty = true
    this._highlightSnapshotId++
    // snapshot id始终递增，保证deferred期间到达的setter仍会让旧callback失效。
    // 只有可证明的Markdown prefix append才允许跳过abort；其余变更必须立即释放旧worker。
    if (!preserveMarkdownCache) {
      // semantic rewrite清除boundary cursor，防止旧文档的line offset被新文档误用。
      this._markdownHighlightCache = undefined
    }
    if (abortActive) this._highlightAbortController?.abort()
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
      const markdownResult =
        snapshot.streaming && snapshot.filetype === "markdown"
          ? await this.highlightMarkdown(snapshot, abortController.signal)
          : undefined
      const result = markdownResult ?? (await this.highlightWithAbort(snapshot, abortController.signal))

      if (!this.isCurrentSnapshot(snapshot)) {
        if (markdownResult && this.canSeedMarkdownCache(snapshot)) {
          // 旧快照只预热 raw cache；可见提交和 callbacks 仍由最新快照独占。
          // 先把 boundary 推到当前文本，finally 才能判断应立即追赶还是进入 deferred 状态。
          markdownResult.cache.boundary = advanceMarkdownBoundary(this._content, markdownResult.cache.boundary)
          this._markdownHighlightCache = markdownResult.cache
        }
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
    // boundary先于cache cut计算，确保reference/fence状态不会因复用旧stable prefix而倒退。
    // 只有严格prefix且frontmatter语义一致时，历史highlights才有资格继续参与结果。
    const boundary = advanceMarkdownBoundary(content, previous?.boundary)
    const cut = markdownBoundaryCut(boundary)
    const canReuse =
      // stable prefix只有在frontmatter和文本prefix同时兼容时才可复用。
      previous &&
      content.startsWith(previous.content) &&
      previous.frontmatterState === frontmatterState &&
      cut >= previous.cut

    let cachedCut = canReuse ? previous.cut : 0
    let cachedHighlights = canReuse ? previous.highlights : []

    if (cut > cachedCut) {
      const segment = await this.highlightMarkdownFragment(snapshot, signal, content.slice(cachedCut, cut))
      cachedHighlights = cachedHighlights.concat(shiftHighlights(segment, cachedCut))
      cachedCut = cut
    }

    const tail = content.slice(cachedCut)
    // tail始终保留完整上下文；只有boundary cut对应的closed prefix才允许单独复用。
    const tailHighlights = tail.length === 0 ? [] : await this.highlightMarkdownFragment(snapshot, signal, tail)

    return {
      highlights: cachedHighlights.concat(shiftHighlights(tailHighlights, cachedCut)),
      cache: {
        content,
        cut: cachedCut,
        frontmatterState,
        highlights: cachedHighlights,
        boundary,
        parsedLength: content.length,
        parsedLines: boundary.lineCount,
        parsedFenceStart: boundary.openFenceStart,
      },
    }
  }

  private canSeedMarkdownCache(snapshot: HighlightSnapshot): boolean {
    // raw highlight cache 仍受全部可见语义输入约束，避免样式或 callback更新后复用旧快照。
    // content 必须保持严格前缀关系；rewrite 的旧结果只能丢弃，不能成为新的 cache 起点。
    return (
      this._streaming &&
      this._filetype === "markdown" &&
      this._content.startsWith(snapshot.content) &&
      this._treeSitterClient === snapshot.treeSitterClient &&
      this._syntaxStyle === snapshot.syntaxStyle &&
      this._conceal === snapshot.conceal &&
      this._drawUnstyledText === snapshot.drawUnstyledText &&
      this._baseHighlight === snapshot.baseHighlight &&
      this._onHighlight === snapshot.onHighlight &&
      this._onChunks === snapshot.onChunks
    )
  }

  private shouldDeferMarkdownHighlight(): boolean {
    // cache缺失时必须正常解析，不能让新的Markdown文档继承未知的deferred状态。
    const cache = this._markdownHighlightCache
    if (!cache || !this._streaming || this._filetype !== "markdown") return false
    if (!this._content.startsWith(cache.content)) return false
    // cache.content是最近一次真实解析的快照，任何rewrite都必须退出deferred路径。

    const boundary = cache.boundary
    if (boundary.openFenceStart === undefined || boundary.openFenceStart !== cache.parsedFenceStart) return false

    // dirty 状态继续保留；只有阈值或合法 closer 到达才重新进入同一 full-context 主路径。
    // parsedFenceStart 必须相同，否则新 opener需要立即解析，不能借前一个 fence的预算延迟。
    return (
      boundary.lineCount - cache.parsedLines < OPEN_FENCE_BATCH_LINES &&
      this._content.length - cache.parsedLength < OPEN_FENCE_BATCH_CHARS
    )
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
    // deferred返回时刻意不清除dirty；下一次append、closure或semantic setter仍能触发同一入口。
    if (this.shouldDeferMarkdownHighlight()) return

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

function advanceMarkdownBoundary(content: string, previous?: MarkdownBoundaryState): MarkdownBoundaryState {
  // 只有 append-only caller会传入previous；长度回退时重建完整状态，避免复用错误cursor。
  // 浅拷贝保护已完成parse的快照，后续append只能推进当前边界状态。
  const state =
    previous && previous.contentLength <= content.length
      ? { ...previous }
      : {
          contentLength: 0,
          scanOffset: 0,
          lineCount: 0,
          lastSafe: 0,
          referenceBlocked: false,
        }

  let lineStart = state.scanOffset
  // indexOf从cursor开始，保证长代码的同步边界成本只随新增suffix增长。
  for (let newline = content.indexOf("\n", lineStart); newline !== -1; newline = content.indexOf("\n", lineStart)) {
    // 只处理完整行；最后的partial line留给下次append，与closer的整行合同一致。
    const line = content.slice(lineStart, newline)
    const trimmed = line.trim()

    if (state.lineCount === 0) {
      // frontmatter只可能从文首开始；首行确定后，后续append不得重新解释历史文本。
      const marker = /^(---|\+\+\+)\s*$/.exec(line)?.[1]
      if (marker === "---" || marker === "+++") state.frontmatterMarker = marker
    } else if (state.frontmatterMarker) {
      // frontmatter未闭合前不解释fence/reference，避免YAML内容污染Markdown边界状态。
      if (trimmed === state.frontmatterMarker) {
        state.frontmatterMarker = undefined
        state.frontmatterEnd = newline + 1
        state.lastSafe = state.frontmatterEnd
      }
      state.lineCount++
      lineStart = newline + 1
      state.scanOffset = lineStart
      continue
    }

    if (!state.frontmatterMarker) {
      const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
      if (state.openFenceStart !== undefined) {
        // closer 的 marker 后只能有空白；```text 在代码块内不能提前关闭 fence。
        // marker字符和最短长度沿用opener，tilde/backtick不得互相关闭。
        const closer = /^(`{3,}|~{3,})[ \t]*$/.exec(trimmed)?.[1]
        if (closer && closer[0] === state.fenceMarker?.[0] && closer.length >= state.fenceMarker.length) {
          state.openFenceStart = undefined
          state.fenceMarker = undefined
          state.fenceRollback = undefined
        }
      } else if (marker) {
        // opener可以携带info string；只有closer才要求marker后纯空白。
        state.openFenceStart = lineStart
        state.fenceMarker = marker
        // fence 内部的空行不能推进 stable prefix，回退点在 opener 到达时就固定。
        state.fenceRollback = state.lastSafe
      } else if (hasReferenceUsage(line)) {
        // 后续 definition仍可能改变 usage 语义，之后的 append 只能扫描状态而不能推进 cut。
        // 该冻结是保守且单向的，直到rewrite或semantic invalidation重建cache。
        state.referenceBlocked = true
      } else if (!state.referenceBlocked && trimmed === "") {
        // 空行只在fence/reference之外推进stable cut，保证后续block仍有完整上下文。
        state.lastSafe = newline + 1
      }
    }

    state.lineCount++
    // 每次循环都推进cursor和lineCount，保证同一suffix不会被下一帧重复消费。
    lineStart = newline + 1
    state.scanOffset = lineStart
  }

  state.contentLength = content.length
  return state
}

function markdownBoundaryCut(state: MarkdownBoundaryState): number {
  // open frontmatter必须保留全文上下文；closed frontmatter才可成为最早稳定前缀。
  if (state.frontmatterMarker) return 0
  // open fence内部即使出现空行，也只能回到opener到达前记录的rollback点。
  if (state.openFenceStart !== undefined) return Math.min(state.lastSafe, state.fenceRollback ?? state.lastSafe)
  // frontmatter关闭位置是独立的稳定边界，不能被后续普通Markdown空行覆盖。
  if (state.frontmatterEnd !== undefined) return Math.max(state.frontmatterEnd, state.lastSafe)
  // reference冻结或普通文本都从最近确认的完整空行结束，绝不切入partial line。
  // 这个返回值是stable-prefix cache唯一的边界来源，不能由tail highlights反向推断。
  return state.lastSafe
}

function hasReferenceUsage(line: string): boolean {
  if (/^\s{0,3}\[[^\]\n]+\]:/.test(line)) return false

  const match = /!?\[[^\]\n]+\](?:\[[^\]\n]*\])?/.exec(line)
  if (!match) return false

  const next = line[match.index + match[0].length]
  return next !== "(" && next !== ":"
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
