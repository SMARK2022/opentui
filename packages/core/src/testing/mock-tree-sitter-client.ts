import { TreeSitterClient } from "../lib/tree-sitter/index.js"
import { SystemClock, type Clock, type TimerHandle } from "../lib/clock.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"

export class MockTreeSitterClient extends TreeSitterClient {
  private _highlightPromises: Array<{
    promise: Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }>
    resolve: (result: { highlights?: SimpleHighlight[]; warning?: string; error?: string }) => void
    reject: (error: Error) => void
    timeout?: TimerHandle
    removeAbortListener?: () => void
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
    await super.destroy()
  }

  async highlightOnce(
    content: string,
    filetype: string,
    signal?: AbortSignal,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    if (signal?.aborted) {
      throw createAbortError()
    }

    const { promise, resolve, reject } = Promise.withResolvers<{
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
          this._highlightPromises[index].removeAbortListener?.()
          this._highlightPromises.splice(index, 1)
        }
      }, this._autoResolveTimeout)
    }

    const pending: (typeof this._highlightPromises)[number] = { promise, resolve, reject, timeout }
    if (signal) {
      // 测试替身也必须移除已取消请求，否则后续布局测试会看到不存在的旧任务。
      const abort = () => {
        const index = this._highlightPromises.indexOf(pending)
        if (index === -1) return
        if (pending.timeout) this._clock.clearTimeout(pending.timeout)
        this._highlightPromises.splice(index, 1)
        pending.removeAbortListener?.()
        reject(createAbortError())
      }
      signal.addEventListener("abort", abort, { once: true })
      pending.removeAbortListener = () => signal.removeEventListener("abort", abort)
    }

    this._highlightPromises.push(pending)

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
      item.removeAbortListener?.()
      item.resolve(this._mockResult)
      this._highlightPromises.splice(index, 1)
    }
  }

  resolveAllHighlightOnce() {
    for (const item of this._highlightPromises) {
      if (item.timeout) {
        this._clock.clearTimeout(item.timeout)
      }
      item.removeAbortListener?.()
      item.resolve(this._mockResult)
    }
    this._highlightPromises = []
  }

  isHighlighting(): boolean {
    return this._highlightPromises.length > 0
  }
}

function createAbortError(): Error {
  const error = new Error("TreeSitter highlight aborted")
  error.name = "AbortError"
  return error
}
