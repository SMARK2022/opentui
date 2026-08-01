import { TreeSitterClient } from "../lib/tree-sitter/index.js"
import { SystemClock, type Clock, type TimerHandle } from "../lib/clock.js"
import type { SimpleHighlight, StreamingUpdateResult } from "../lib/tree-sitter/types.js"

export class MockTreeSitterClient extends TreeSitterClient {
  private _highlightPromises: Array<{
    promise: Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }>
    resolve: (result: { highlights?: SimpleHighlight[]; warning?: string; error?: string }) => void
    timeout?: TimerHandle
  }> = []
  private _mockResult: { highlights?: SimpleHighlight[]; warning?: string; error?: string } = { highlights: [] }
  private _autoResolveTimeout?: number
  private readonly _clock: Clock

  constructor(options?: { autoResolveTimeout?: number; clock?: Clock }) {
    super({ dataPath: "/tmp/mock" }, { autoStartWorker: false })
    this._autoResolveTimeout = options?.autoResolveTimeout
    this._clock = options?.clock ?? new SystemClock()
  }

  override async destroy(): Promise<void> {
    this.resolveAllHighlightOnce()
    for (const update of this._streamingUpdates.splice(0)) {
      update.resolve({ version: 0, changedStart: 0, tailStart: 0, highlights: [], stale: true })
    }
    await super.destroy()
  }

  async highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    const { promise, resolve } = Promise.withResolvers<{
      highlights?: SimpleHighlight[]
      warning?: string
      error?: string
    }>()

    let timeout: TimerHandle | undefined

    if (this._autoResolveTimeout !== undefined) {
      timeout = this._clock.setTimeout(() => {
        const index = this._highlightPromises.findIndex((p) => p.promise === promise)
        if (index !== -1) {
          resolve(this._mockResult)
          this._highlightPromises.splice(index, 1)
        }
      }, this._autoResolveTimeout)
    }

    this._highlightPromises.push({ promise, resolve, timeout })

    return promise
  }

  setMockResult(result: { highlights?: SimpleHighlight[]; warning?: string; error?: string }) {
    this._mockResult = result
  }

  resolveHighlightOnce(index: number = 0) {
    if (index >= 0 && index < this._highlightPromises.length) {
      const item = this._highlightPromises[index]
      if (item.timeout) {
        this._clock.clearTimeout(item.timeout)
      }
      item.resolve(this._mockResult)
      this._highlightPromises.splice(index, 1)
    }
  }

  resolveAllHighlightOnce() {
    for (const { resolve, timeout } of this._highlightPromises) {
      if (timeout) {
        this._clock.clearTimeout(timeout)
      }
      resolve(this._mockResult)
    }
    this._highlightPromises = []
  }

  isHighlighting(): boolean {
    return this._highlightPromises.length > 0
  }

  // ---- managed streaming buffer seam（与真实 client 的公共协议保持一致） ----
  // mock 复制真实 client 的可观察合同而不是内部实现：创建/更新/释放历史与 stale 语义都可断言。

  private _streamingUpdates: Array<{
    id: number
    content: string
    cacheEnd: number
    resolve: (result: StreamingUpdateResult) => void
    reject: (error: Error) => void
  }> = []
  private _streamingIdCounter = 0
  private _streamingResultHandler?: (content: string, cacheEnd: number) => StreamingUpdateResult
  public readonly createdStreamingBuffers: Array<{ id: number; content: string; filetype: string }> = []
  public readonly removedStreamingBuffers: number[] = []
  // 默认立即放行；需要制造在途窗口的测试（stale/rejection）显式关闭它。
  public streamingAutoResolve = true

  private _streamingCreates: Array<{
    content: string
    filetype: string
    resolve: (id: number | null) => void
  }> = []

  // create 与 update 的挂起开关分离：stale/rejection 测试只挂 update，竞态测试才挂 create。
  public streamingCreateAutoResolve = true

  override async createStreamingBuffer(content: string, filetype: string): Promise<number | null> {
    if (!this.streamingCreateAutoResolve) {
      const { promise, resolve } = Promise.withResolvers<number | null>()
      this._streamingCreates.push({ content, filetype, resolve })
      return promise
    }
    // 记录创建历史：测试用创建次数证明 persistent path 没有退化为逐帧 one-shot。
    const id = --this._streamingIdCounter
    this.createdStreamingBuffers.push({ id, content, filetype })
    return id
  }

  resolveStreamingCreate(index: number = 0): void {
    const create = this._streamingCreates[index]
    if (!create) return
    this._streamingCreates.splice(index, 1)
    const id = --this._streamingIdCounter
    this.createdStreamingBuffers.push({ id, content: create.content, filetype: create.filetype })
    create.resolve(id)
  }

  override async updateStreamingBuffer(id: number, content: string, cacheEnd: number): Promise<StreamingUpdateResult> {
    // 与 highlightOnce 相同的可控挂起模式：测试可以决定每次更新何时、以什么结果完成。
    const { promise, resolve, reject } = Promise.withResolvers<StreamingUpdateResult>()
    this._streamingUpdates.push({ id, content, cacheEnd, resolve, reject })
    if (this.streamingAutoResolve) {
      this.resolveStreamingUpdate(this._streamingUpdates.length - 1)
    }
    return promise
  }

  override async removeStreamingBuffer(id: number): Promise<void> {
    this.removedStreamingBuffers.push(id)
    // 真实 client 在 owner 释放后会让在途响应标记 stale；mock 复现同一可观察合同。
    for (const update of this._streamingUpdates.splice(0)) {
      update.resolve({ version: 0, changedStart: 0, tailStart: 0, highlights: [], stale: true })
    }
  }

  setStreamingResultHandler(handler: (content: string, cacheEnd: number) => StreamingUpdateResult): void {
    this._streamingResultHandler = handler
  }

  resolveStreamingUpdate(index: number = 0, result?: StreamingUpdateResult): void {
    const update = this._streamingUpdates[index]
    if (!update) return
    this._streamingUpdates.splice(index, 1)
    // 缺省结果的 tailStart 取 0：tailStart 之前的 block 才可缓存，0 表示全部按 tail 全量转换，
    // 是绝不会把陈旧内容带进前缀缓存的中性值（真实 worker 对单 block 内容也返回 0）。
    update.resolve(
      result ??
        this._streamingResultHandler?.(update.content, update.cacheEnd) ?? {
          version: 1,
          changedStart: update.content.length,
          tailStart: 0,
          highlights: [],
        },
    )
  }

  resolveAllStreamingUpdates(): void {
    // 与 resolveAllHighlightOnce 同形的批量放行；段落块各自持有独立 loop，常见多个挂起。
    while (this._streamingUpdates.length > 0) {
      this.resolveStreamingUpdate(0)
    }
  }

  rejectStreamingUpdate(index: number = 0, error: Error = new Error("mock streaming update failure")): void {
    const update = this._streamingUpdates[index]
    if (!update) return
    this._streamingUpdates.splice(index, 1)
    update.reject(error)
  }

  pendingStreamingUpdates(): number {
    // 挂起数量是“更新已发出但未完成”的唯一公开信号，stale 测试依赖它确认在途窗口。
    return this._streamingUpdates.length
  }
}
