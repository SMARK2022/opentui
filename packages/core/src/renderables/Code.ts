import { type LineInfo, type RenderContext } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { getTreeSitterClient, TreeSitterClient } from "../lib/tree-sitter/index.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { SimpleHighlight, StreamingUpdateResult } from "../lib/tree-sitter/types.js"
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
  private _treeSitterClient: TreeSitterClient
  private _highlightsDirty: boolean = false
  private _highlightSnapshotId: number = 0
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _initialStyledText?: StyledText
  private _hadInitialContent: boolean = false
  private _lastHighlights: SimpleHighlight[] = []
  private _baseHighlight?: string
  private _onHighlight?: OnHighlightCallback
  private _onChunks?: OnChunksCallback
  private _highlightingPromise: Promise<void> = Promise.resolve()
  // streaming Markdown persistent buffer：一个 buffer、一个 active 更新、一个最新 pending 内容。
  private _streamingBufferId?: number
  private _streamingActive: boolean = false
  private _streamingPending?: string
  private _streamingIdle: Promise<void> = Promise.resolve()
  private _streamingIdleResolve?: () => void
  // 前缀缓存只保存 onChunks 之前的 chunk；end 是 parser 给出的 tailStart（code-unit 块边界）。
  private _prefixCache?: { end: number; chunks: TextChunk[] }
  // 缓存失效代数：在途响应的裁剪基准（请求时的 cacheEnd）一旦失效就必须被识别并丢弃。
  private _cacheGeneration: number = 0
  // worker 只返回变化区间的 highlights，全量数组在这里增量合并，供 onHighlight 与 conceal 映射使用。
  private _cachedHighlights: SimpleHighlight[] = []
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
      if (this._initialStyledText) {
        this.textBuffer.setStyledText(this._initialStyledText)
      } else {
        this.textBuffer.setText(this._content)
      }
      this.updateTextInfo()
      this._shouldRenderTextBuffer = !!this._initialStyledText || this._drawUnstyledText || !this._filetype
    }

    this._highlightsDirty = this._content.length > 0
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this._content !== value) {
      this._content = value
      this._highlightsDirty = true
      this._highlightSnapshotId++

      if (this._streaming && this._filetype && !this._drawUnstyledText) {
        if (this._initialStyledText) this.commitPendingRepresentation()
        this.requestRender()
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
      // grammar owner 变化不是 generic reset：必须先释放旧 buffer，再由当前 filetype 懒重建。
      this.releaseStreamingBuffer()
      this._filetype = value
      this._highlightsDirty = true
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      // chunk 由 style 派生，缓存 chunk 失效；parser tree 与 highlights 缓存仍然有效。
      this._prefixCache = undefined
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      // conceal 改变 chunk 文本本身（移除/替换标记符），缓存 chunk 必须重建。
      this._prefixCache = undefined
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      // 该 setter 改变 failure 后的可见语义，必须让在途请求被既有 generation 检查识别。
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set initialStyledText(value: StyledText | undefined) {
    if (this._initialStyledText !== value) {
      this._initialStyledText = value
      if (this._streamingActive) {
        // active request 中 seed 只属于等待期表示；清空 seed 不能提前打开未高亮正文。
        if (value) this.commitPendingRepresentation()
        this.requestRender()
        return
      }
      this._highlightsDirty = true
    }
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this.releaseStreamingBuffer()
      this._streaming = value
      this._hadInitialContent = false
      this._lastHighlights = []
      this._highlightsDirty = true
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      // buffer 属于旧 client 的 worker 协议，必须通过旧 client 释放，不能带到新 owner。
      this.releaseStreamingBuffer()
      this._treeSitterClient = value
      this._highlightsDirty = true
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
      this._prefixCache = undefined
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  set onHighlight(value: OnHighlightCallback | undefined) {
    if (this._onHighlight !== value) {
      this._onHighlight = value
      // 任意 onHighlight range 可能跨越缓存切点，存在期间禁用前缀 chunk 缓存。
      this._prefixCache = undefined
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  get onChunks(): OnChunksCallback | undefined {
    return this._onChunks
  }

  set onChunks(value: OnChunksCallback | undefined) {
    if (this._onChunks !== value) {
      this._onChunks = value
      // callback 会改变最终 chunk 文本，失败结算必须保留这次渲染语义失效。
      this._cacheGeneration++
      this._highlightsDirty = true
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting
  }

  get highlightingDone(): Promise<void> {
    return this._highlightingPromise
  }

  protected async transformChunks(chunks: TextChunk[], context: ChunkRenderContext): Promise<TextChunk[]> {
    if (!this._onChunks) return chunks

    const modified = await this._onChunks(chunks, context)
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

    if (this._initialStyledText) {
      this.commitPendingRepresentation()
    } else if (this._streaming && !isInitialContent) {
      this._shouldRenderTextBuffer = true
    } else if (shouldDrawUnstyledNow) {
      this.commitPendingRepresentation()
    } else {
      this._shouldRenderTextBuffer = false
    }
  }

  private commitPendingRepresentation(): void {
    // 异步高亮未完成时先提交当前表示，保持正文可见且不把未高亮模式变成常开成功路径。
    if (this._initialStyledText) {
      this.textBuffer.setStyledText(this._initialStyledText)
    } else {
      this.textBuffer.setText(this._content)
    }
    this.setRenderedLineSources(undefined)
    this._shouldRenderTextBuffer = true
    this.updateTextInfo()
  }

  private startHighlight(): Promise<void> {
    // streaming Markdown 走 persistent buffer 主路径；non-streaming 与非 Markdown 保持既有 one-shot。
    if (this._streaming && this._filetype === "markdown") {
      return this.startStreamingHighlight()
    }
    return this.startOneShotHighlight()
  }

  private releaseStreamingBuffer(): void {
    const id = this._streamingBufferId
    this._streamingBufferId = undefined
    this._prefixCache = undefined
    this._cachedHighlights = []
    this._cacheGeneration++
    if (id !== undefined) {
      // 释放走当前持有该 buffer 的 client；在途响应会被标记 stale，不会进入提交路径。
      // client 先于释放完成而被 destroy 时 dispose 请求会被拒绝，该关停竞态无可观察后果，但不能成为未处理 rejection。
      void this._treeSitterClient.removeStreamingBuffer(id).catch(() => {})
    }
  }

  protected override destroySelf(): void {
    // Renderable.destroy 的统一清理钩子；buffer 释放与父类原生清理保持同一顺序。
    this.releaseStreamingBuffer()
    super.destroySelf()
  }

  private startStreamingHighlight(): Promise<void> {
    // _hadInitialContent 与 ensureVisibleTextBeforeHighlight 的首帧可见性合同联动，两条路径都必须维护。
    const isInitialContent = !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true
    // latest-wins 合并：active 期间到达的旧 pending 直接被最新内容替换，避免 one-shot 式队列堆积。
    this._streamingPending = this._content
    // highlightingDone 必须等“队列完全排空”，否则调用方会在最新内容尚未提交时就渲染。
    if (this._streamingActive) return this._streamingIdle

    this._streamingIdle = new Promise((resolve) => {
      this._streamingIdleResolve = resolve
    })
    void this.runStreamingLoop()
    return this._streamingIdle
  }

  private async runStreamingLoop(): Promise<void> {
    // 任意时刻只有一个 loop 在跑；active 期间的更新全部通过 _streamingPending 合并进来。
    this._streamingActive = true
    try {
      while (this._streamingPending !== undefined) {
        const content = this._streamingPending
        this._streamingPending = undefined
        // snapshot 在取出内容时记录；之后的每个 await 点都要用它验证自己不是旧帧。
        const snapshot = this._highlightSnapshotId
        // failure 结算要区分 pending seed 变化和真正改变渲染缓存语义的 setter。
        const requestCacheGeneration = this._cacheGeneration

        try {
          if (this._streamingBufferId === undefined) {
            // buffer 懒创建：首次内容到达时才占用 worker parser，非 Markdown 路径完全不涉及。
            const id = await this._treeSitterClient.createStreamingBuffer(content, "markdown")
            if (id === null) throw new Error("No markdown parser available for streaming buffer")
            if (this.isDestroyed) {
              // create 的在途窗口内 destroy 时 id 尚未登记，releaseStreamingBuffer 不会覆盖它；
              // 必须就地释放，否则 worker 永久持有这颗 parser tree（INV-06）。
              void this._treeSitterClient.removeStreamingBuffer(id).catch(() => {})
              break
            }
            this._streamingBufferId = id
          }

          // onHighlight 存在时禁用前缀缓存，worker 必须返回全量 highlights（cacheEnd = 0）。
          const cacheEnd = this._onHighlight ? 0 : (this._prefixCache?.end ?? 0)
          const cacheGeneration = this._cacheGeneration
          const result = await this._treeSitterClient.updateStreamingBuffer(this._streamingBufferId, content, cacheEnd)

          // stale 响应只是 owner 转移的副产品，直接丢弃；它不是错误，不能进入 plain-text 兼容路径。
          if (result.stale || this.isDestroyed) continue
          // 每个 await 之后都必须重查 snapshot：等待期间内容可能已更新，旧快照提交即为错位帧。
          if (snapshot !== this._highlightSnapshotId) {
            this.requestRender()
            continue
          }
          // 在途窗口内样式/回调 setter 已使缓存失效时，响应只携带裁剪后的 highlights；
          // 提交它会把残缺数据重建为缓存，必须按 stale 丢弃，dirty 标志会驱动全量重取。
          if (cacheGeneration !== this._cacheGeneration) {
            this.requestRender()
            continue
          }

          await this.commitStreamingResult(content, result, snapshot, cacheGeneration)
        } catch (error) {
          // 失败快照的唯一兼容行为：提交当前原文 plain text，不触发成功回调、不重试其他 parser。
          if (snapshot !== this._highlightSnapshotId) {
            this.requestRender()
            continue
          }
          // renderable先销毁但live error后到时也不应在退出阶段制造噪声。
          if (this.isDestroyed) continue
          console.warn("Code streaming highlight failed:", error)
          // rejection 必须提交本请求的原文；pending seed 可独立变化，不能作为失败终态。
          this._prefixCache = undefined
          this._cachedHighlights = []
          this.textBuffer.setText(content)
          this.setRenderedLineSources(undefined)
          // 失败只恢复当前帧可见性；只有真正改变缓存语义的在途 setter 才保留 dirty。
          this._shouldRenderTextBuffer = true
          // active seed 不会置 dirty；此处只保留在途渲染语义 setter 的 cache invalidation。
          this._highlightsDirty = requestCacheGeneration !== this._cacheGeneration
          this.updateTextInfo()
          this.requestRender()
        }
      }
    } finally {
      this._streamingActive = false
      this._isHighlighting = false
      const resolve = this._streamingIdleResolve
      this._streamingIdleResolve = undefined
      resolve?.()
    }
  }

  private async commitStreamingResult(
    content: string,
    result: StreamingUpdateResult,
    snapshot: number,
    cacheGeneration: number,
  ): Promise<void> {
    const filetype = this._filetype
    if (!filetype) return

    // clipStart 与 worker 的裁剪点一致：之前的 highlights 稳定，之后的以当前响应为准。
    const cacheEnd = this._onHighlight ? 0 : (this._prefixCache?.end ?? 0)
    const clipStart = Math.min(result.changedStart, result.tailStart, cacheEnd)
    // 增量合并还原全量 highlights：onHighlight 合同与 conceal 行映射都依赖完整范围。
    this._cachedHighlights = [
      ...this._cachedHighlights.filter((highlight) => highlight[1] <= clipStart),
      ...result.highlights,
    ]

    let highlights = this._cachedHighlights
    if (this._onHighlight) {
      // onHighlight 始终收到完整当前 highlights；其任意 range 可能跨越切点，因此它存在时不复用前缀 chunk。
      const modified = await this._onHighlight(highlights, {
        content,
        filetype,
        syntaxStyle: this._syntaxStyle,
      })
      if (modified !== undefined) {
        highlights = modified
      }
    }

    if (snapshot !== this._highlightSnapshotId || cacheGeneration !== this._cacheGeneration) {
      this.requestRender()
      return
    }
    if (this.isDestroyed) return

    const cache = this._prefixCache
    let chunks: TextChunk[]
    if (!this._onHighlight && cache && cache.end <= clipStart) {
      // cache.end <= clipStart 表示缓存区间内没有任何变化或边界回退：沿用前缀 chunk，只转换 tail。
      chunks = [...cache.chunks, ...this.convertHighlightRegion(content, highlights, cache.end, content.length)]
      // 缓存随 tailStart 前移而扩展：[cache.end, tailStart) 这段刚闭合的 block 从此进入稳定前缀。
      this._prefixCache = {
        end: result.tailStart,
        chunks: [...cache.chunks, ...this.convertHighlightRegion(content, highlights, cache.end, result.tailStart)],
      }
    } else {
      // 缓存失效或不存在：全量转换一次并重建缓存，后续帧恢复增量。
      chunks = this.convertHighlightRegion(content, highlights, 0, content.length)
      this._prefixCache = this._onHighlight
        ? undefined
        : { end: result.tailStart, chunks: this.convertHighlightRegion(content, highlights, 0, result.tailStart) }
    }

    // onChunks 可能任意改写文本，conceal 行映射只在无 onChunks 时有效（与既有路径一致）。
    const renderedLineSources = this._onChunks ? undefined : this.getConcealLinesSourceMap(content, highlights)

    if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
      // onChunks 合同与既有路径相同：拿到的是 prefix+tail 拼接后的完整当前 chunk 流，不是局部 tail。
      chunks = await this.transformChunks(chunks, { content, filetype, syntaxStyle: this._syntaxStyle, highlights })

      if (snapshot !== this._highlightSnapshotId || cacheGeneration !== this._cacheGeneration) {
        this.requestRender()
        return
      }
      if (this.isDestroyed) return

      this.textBuffer.setStyledText(new StyledText(chunks))
      this.setRenderedLineSources(renderedLineSources)
    } else {
      this.textBuffer.setText(content)
      this.setRenderedLineSources(undefined)
    }

    this.commitStreamingVisible()
  }

  private convertHighlightRegion(
    content: string,
    highlights: SimpleHighlight[],
    start: number,
    end: number,
  ): TextChunk[] {
    // 全范围转换与既有 one-shot 走完全相同的调用，不经过 slice，避免两种路径产生任何行为分叉。
    if (start === 0 && end === content.length) {
      return treeSitterToTextChunks(content, highlights, this._syntaxStyle, {
        enabled: this._conceal,
        baseHighlight: this._baseHighlight,
      })
    }

    // tailStart/cacheEnd 都是 block 起点，highlights 不跨切点，区域转换与全量转换逐位一致。
    // 例外是 closing-fence synthetic newline：parse 域 highlight 可越过 source 末端，
    // 全量路径靠 slice 自然截断它；区域转换也必须保留该 span，否则尾部会少一个空 chunk。
    const crossesEnd = end < content.length
    const regionHighlights: SimpleHighlight[] = []
    for (const highlight of highlights) {
      if (highlight[1] <= start || (crossesEnd && highlight[0] >= end)) continue
      const clipped: SimpleHighlight = [
        Math.max(highlight[0], start) - start,
        (crossesEnd ? Math.min(highlight[1], end) : highlight[1]) - start,
        highlight[2],
      ]
      if (highlight[3]) clipped.push(highlight[3])
      regionHighlights.push(clipped)
    }
    return treeSitterToTextChunks(content.slice(start, end), regionHighlights, this._syntaxStyle, {
      enabled: this._conceal,
      baseHighlight: this._baseHighlight,
    })
  }

  private commitStreamingVisible(): void {
    // 与 one-shot 成功/失败提交使用同一组可见性标志，renderSelf 的后续行为不区分路径。
    this._shouldRenderTextBuffer = true
    this._highlightsDirty = false
    this.updateTextInfo()
    this.requestRender()
  }

  private async startOneShotHighlight(): Promise<void> {
    const content = this._content
    const filetype = this._filetype
    const snapshotId = ++this._highlightSnapshotId

    if (!filetype) return

    const isInitialContent = this._streaming && !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true

    try {
      const result = await this._treeSitterClient.highlightOnce(content, filetype)

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      let highlights = result.highlights ?? []

      if (this._onHighlight && highlights.length >= 0) {
        const context: HighlightContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
        }
        const modified = await this._onHighlight(highlights, context)
        if (modified !== undefined) {
          highlights = modified
        }
      }

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      if (highlights.length > 0) {
        if (this._streaming) {
          this._lastHighlights = highlights
        }
      }

      if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
        const context: ChunkRenderContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
          highlights,
        }

        let chunks = treeSitterToTextChunks(content, highlights, this._syntaxStyle, {
          enabled: this._conceal,
          baseHighlight: this._baseHighlight,
        })
        // onChunks may rewrite text arbitrarily, so the conceal-only source map would be invalid.
        const renderedLineSources = this._onChunks ? undefined : this.getConcealLinesSourceMap(content, highlights)

        chunks = await this.transformChunks(chunks, context)

        if (snapshotId !== this._highlightSnapshotId) {
          this.requestRender()
          return
        }

        if (this.isDestroyed) return

        const styledText = new StyledText(chunks)
        this.textBuffer.setStyledText(styledText)
        this.setRenderedLineSources(renderedLineSources)
      } else {
        this.textBuffer.setText(content)
        this.setRenderedLineSources(undefined)
      }

      this._shouldRenderTextBuffer = true
      this._isHighlighting = false
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } catch (error) {
      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return
      console.warn("Code highlighting failed:", error)
      // failure 终态只能提交本次请求捕获的原文，不能读取可能已变更的 pending seed。
      this.textBuffer.setText(content)
      this.setRenderedLineSources(undefined)
      this._shouldRenderTextBuffer = true
      this._isHighlighting = false
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    }
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

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._highlightsDirty) {
      if (this.isDestroyed) return

      if (this._content.length === 0) {
        this._shouldRenderTextBuffer = false
        this._highlightsDirty = false
      } else if (!this._filetype) {
        this._shouldRenderTextBuffer = true
        this._highlightsDirty = false
      } else {
        this.ensureVisibleTextBeforeHighlight()
        this._highlightsDirty = false
        this._highlightingPromise = this.startHighlight()
      }
    }

    if (!this._shouldRenderTextBuffer) return
    super.renderSelf(buffer)
  }
}
