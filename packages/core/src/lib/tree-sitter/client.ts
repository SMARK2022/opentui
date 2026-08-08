import { EventEmitter } from "events"
import type {
  TreeSitterClientOptions,
  TreeSitterClientEvents,
  BufferState,
  FiletypeParserOptions,
  Edit,
  HighlightResponse,
  PerformanceStats,
  SimpleHighlight,
  StreamingUpdateResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResponse,
} from "./types.js"
import { getParsers } from "./default-parsers.js"
import { resolve, isAbsolute, parse } from "path"
import { existsSync } from "fs"
import { registerEnvVar, env } from "../env.js"
import { isBunfsPath, normalizeBunfsPath } from "../bunfs.js"
import {
  type PlatformWorkerHandle,
  type WorkerErrorEvent,
  type WorkerMessageEvent,
  Worker as PlatformWorker,
} from "../../platform/worker.js"

registerEnvVar({
  name: "OTUI_TREE_SITTER_WORKER_PATH",
  description: "Path to the TreeSitter worker entry script",
  type: "string",
  default: "",
})

declare global {
  const OTUI_TREE_SITTER_WORKER_PATH: string
}

type TreeSitterWorkerPath = string | URL
type TreeSitterWorkerHandle = Pick<PlatformWorkerHandle, "onerror" | "onmessage" | "postMessage" | "terminate">

interface TreeSitterClientInternalOptions {
  autoStartWorker?: boolean
}

interface PendingRequest {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
}

type EditResponse = { highlights?: HighlightResponse[]; error?: string }

let DEFAULT_PARSER_OVERRIDES: FiletypeParserOptions[] = []

export function addDefaultParsers(parsers: FiletypeParserOptions[]): void {
  for (const parser of parsers) {
    DEFAULT_PARSER_OVERRIDES = [
      ...DEFAULT_PARSER_OVERRIDES.filter((existingParser) => existingParser.filetype !== parser.filetype),
      parser,
    ]
  }
}

const isUrl = (path: string) => path.startsWith("http://") || path.startsWith("https://")

// Parser options now support both URLs and local file paths
// TODO: TreeSitterClient should have a setOptions method, passing it on to the worker etc.
export class TreeSitterClient extends EventEmitter<TreeSitterClientEvents> {
  private initialized = false
  private worker: TreeSitterWorkerHandle | undefined
  private buffers: Map<number, BufferState> = new Map()
  private initializePromise: Promise<void> | undefined
  private initializeResolvers:
    | { resolve: () => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
    | undefined
  private messageCallbacks = new Map<string, PendingRequest>()
  private messageIdCounter: number = 0
  // buffer mirror 只有在 worker 的同一请求完成后才推进，避免本地版本先于 WASM Tree 成为假状态。
  private bufferOperations: Map<number, Promise<unknown>> = new Map()
  private options: TreeSitterClientOptions
  private destroyCallbacks = new Set<() => void>()
  private lifecycleGeneration = 0
  private rejectInitialization: ((error: Error) => void) | undefined
  private destroyPromise: Promise<void> | undefined
  private workerTerminationFailed = false

  constructor(options: TreeSitterClientOptions, internalOptions: TreeSitterClientInternalOptions = {}) {
    super()
    this.options = options
    if (internalOptions.autoStartWorker ?? true) {
      this.startWorker()
    }
  }

  public onDestroy(callback: () => void): () => void {
    this.destroyCallbacks.add(callback)
    return () => {
      this.destroyCallbacks.delete(callback)
    }
  }

  private emitError(error: string, bufferId?: number): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error, bufferId)
    }
  }

  private emitWarning(warning: string, bufferId?: number): void {
    if (this.listenerCount("warning") > 0) {
      this.emit("warning", warning, bufferId)
    }
  }

  private startWorker() {
    if (this.worker) {
      return
    }

    const workerPath = this.resolveWorkerPath()

    const worker = new PlatformWorker(workerPath)
    this.worker = worker

    worker.onmessage = (event) => {
      if (this.worker !== worker) {
        return
      }

      this.handleWorkerMessage(event as WorkerMessageEvent<TreeSitterWorkerResponse>)
    }

    worker.onerror = (error: WorkerErrorEvent) => {
      if (this.worker !== worker) {
        return
      }

      console.error("TreeSitter worker error:", error.message)
      const workerError = new Error(`Worker error: ${error.message}`, { cause: error.error })
      this.handleWorkerFailure(worker, workerError)
      this.emitError(`Worker error: ${error.message}`)
    }
  }

  private sendWorkerMessage(message: TreeSitterWorkerRequest): void {
    if (!this.worker) {
      throw new Error("TreeSitter worker is not available")
    }
    this.worker.postMessage(message)
  }

  private request<T>(messageId: string, message: TreeSitterWorkerRequest): Promise<T> {
    // callback 必须在 postMessage 前登记，否则同步 worker 响应会找不到它的终态接收者。
    return new Promise<T>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve: (response) => resolve(response as T), reject })
      try {
        this.sendWorkerMessage(message)
      } catch (error) {
        // postMessage 失败没有 worker response，必须立即移除 callback 并把异常交回调用方。
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private enqueueBufferOperation<T>(bufferId: number, operation: () => Promise<T>, afterSettlement = false): Promise<T> {
    // rejected mutation 仍需让 disposal 接管；afterSettlement 是释放路径唯一允许越过失败的边界。
    const previous = this.bufferOperations.get(bufferId) ?? Promise.resolve()
    const result = afterSettlement ? previous.then(operation, operation) : previous.then(operation)
    this.bufferOperations.set(bufferId, result)
    void result
      .finally(() => {
        if (this.bufferOperations.get(bufferId) === result) this.bufferOperations.delete(bufferId)
      })
      .catch(() => undefined)
    return result
  }

  private rejectPendingRequests(error: Error): void {
    const requests = Array.from(this.messageCallbacks.values())
    this.messageCallbacks.clear()
    for (const request of requests) {
      request.reject(error)
    }
  }

  private rejectActiveInitialization(error: Error): void {
    if (this.initializeResolvers) {
      clearTimeout(this.initializeResolvers.timeoutId)
      this.initializeResolvers.reject(error)
      this.initializeResolvers = undefined
    }
    this.rejectInitialization?.(error)
    this.rejectInitialization = undefined
  }

  private handleWorkerFailure(worker: TreeSitterWorkerHandle, error: Error): void {
    if (this.worker !== worker) {
      return
    }

    worker.onmessage = null
    worker.onerror = null
    this.worker = undefined
    this.lifecycleGeneration++
    this.initialized = false
    this.initializePromise = undefined
    this.rejectActiveInitialization(error)
    this.rejectPendingRequests(error)
    // worker 已失效时清除 operation tail，避免旧 buffer 的 rejected chain 阻塞下一次生命周期。
    this.bufferOperations.clear()
    this.buffers.clear()

    try {
      void Promise.resolve(worker.terminate()).catch(() => {})
    } catch {
      // The worker has already failed; cleanup is best effort.
    }
  }

  // Path resolution stays in the client for now; runtime-specific Worker construction lives in platform/worker.
  private resolveWorkerPath(): TreeSitterWorkerPath {
    if (this.options.workerPath) {
      return this.options.workerPath
    }

    if (env.OTUI_TREE_SITTER_WORKER_PATH) {
      return env.OTUI_TREE_SITTER_WORKER_PATH
    }

    if (typeof OTUI_TREE_SITTER_WORKER_PATH !== "undefined") {
      return OTUI_TREE_SITTER_WORKER_PATH
    }

    let workerPath = new URL("./parser.worker.js", import.meta.url).href

    if (!existsSync(resolve(import.meta.dirname, "parser.worker.js"))) {
      workerPath = new URL("./parser.worker.ts", import.meta.url).href
    }

    return workerPath
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    if (!worker) {
      return
    }

    const onmessage = worker.onmessage
    const onerror = worker.onerror
    worker.onmessage = null
    worker.onerror = null
    this.worker = undefined

    try {
      const termination = worker.terminate()
      if (termination && typeof (termination as PromiseLike<number>).then === "function") {
        await termination
      }
    } catch (error) {
      if (!this.worker) {
        worker.onmessage = onmessage
        worker.onerror = onerror
        this.worker = worker
      }
      throw error
    }
  }

  // NOTE: Unused, but useful for debugging and testing
  private async handleReset() {
    this.buffers.clear()
    await this.stopWorker()
    this.startWorker()
    this.initialized = false
    this.initializePromise = undefined
    this.initializeResolvers = undefined
    return this.initialize()
  }

  async initialize(): Promise<void> {
    if (this.destroyPromise) {
      throw new Error("Cannot initialize while client is being destroyed")
    }
    if (this.workerTerminationFailed) {
      throw new Error("Cannot initialize after worker termination failed; retry destroy()")
    }

    if (this.initializePromise) {
      return this.initializePromise
    }

    if (!this.worker) {
      this.startWorker()
    }

    const worker = this.worker!
    const generation = this.lifecycleGeneration
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject
    })
    const initialization = Promise.race([this.initializeClient(generation, worker), cancellation])
    this.rejectInitialization = rejectCancellation
    this.initializePromise = initialization

    void initialization.then(
      () => {
        if (this.initializePromise === initialization) {
          this.rejectInitialization = undefined
        }
      },
      () => {
        if (this.initializePromise === initialization) {
          this.rejectInitialization = undefined
        }
      },
    )

    return this.initializePromise
  }

  private assertCurrentInitialization(generation: number, worker: TreeSitterWorkerHandle): void {
    if (this.lifecycleGeneration !== generation || this.worker !== worker || this.destroyPromise) {
      throw new Error("TreeSitter initialization was invalidated")
    }
  }

  private async initializeClient(generation: number, worker: TreeSitterWorkerHandle): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.initTimeout ?? 10000 // Default to 10 seconds
      const timeoutId = setTimeout(() => {
        const error = new Error("Worker initialization timed out")
        console.error("TreeSitter client:", error.message)
        this.initializeResolvers = undefined
        reject(error)
      }, timeoutMs)

      this.initializeResolvers = { resolve, reject, timeoutId }
      this.sendWorkerMessage({
        type: "INIT",
        dataPath: this.options.dataPath,
      })
    })

    this.assertCurrentInitialization(generation, worker)
    await this.registerDefaultParsers(generation, worker)
    this.assertCurrentInitialization(generation, worker)
    this.initialized = true
  }

  private async registerDefaultParsers(
    generation: number = this.lifecycleGeneration,
    worker: TreeSitterWorkerHandle = this.worker!,
  ): Promise<void> {
    const defaultParsers = await getParsers()
    this.assertCurrentInitialization(generation, worker)
    const overriddenFiletypes = new Set(DEFAULT_PARSER_OVERRIDES.map((parser) => parser.filetype))

    for (const parser of [
      ...defaultParsers.filter((parser) => !overriddenFiletypes.has(parser.filetype)),
      ...DEFAULT_PARSER_OVERRIDES,
    ]) {
      worker.postMessage({ type: "ADD_FILETYPE_PARSER", filetypeParser: this.resolveFiletypeParser(parser) })
    }
  }

  private resolvePath(path: string): string {
    if (isUrl(path)) {
      return path
    }
    if (isBunfsPath(path)) {
      return normalizeBunfsPath(parse(path).base)
    }
    if (!isAbsolute(path)) {
      return resolve(path)
    }
    return path
  }

  public addFiletypeParser(filetypeParser: FiletypeParserOptions): void {
    this.sendWorkerMessage({ type: "ADD_FILETYPE_PARSER", filetypeParser: this.resolveFiletypeParser(filetypeParser) })
  }

  private resolveFiletypeParser(filetypeParser: FiletypeParserOptions): FiletypeParserOptions {
    return {
      ...filetypeParser,
      aliases: filetypeParser.aliases
        ? [...new Set(filetypeParser.aliases.filter((alias) => alias !== filetypeParser.filetype))]
        : undefined,
      wasm: this.resolvePath(filetypeParser.wasm),
      queries: {
        highlights: filetypeParser.queries.highlights.map((path) => this.resolvePath(path)),
        injections: filetypeParser.queries.injections?.map((path) => this.resolvePath(path)),
      },
    }
  }

  public async getPerformance(): Promise<PerformanceStats> {
    const messageId = `performance_${this.messageIdCounter++}`
    return new Promise<PerformanceStats>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({ type: "GET_PERFORMANCE", messageId })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  public async highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    if (!this.initialized) {
      try {
        await this.initialize()
      } catch (error) {
        return { error: "Could not highlight because of initialization error" }
      }
    }

    const messageId = `oneshot_${this.messageIdCounter++}`
    return new Promise((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({
          type: "ONESHOT_HIGHLIGHT",
          content,
          filetype,
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleWorkerMessage(event: WorkerMessageEvent<TreeSitterWorkerResponse>) {
    const message = event.data

    switch (message.type) {
      case "HIGHLIGHT_RESPONSE": {
        // 带 messageId 的 mutation 走 Promise 通道；无 id 的初始高亮仍保留事件兼容性。
        if (message.messageId) {
          const callback = this.messageCallbacks.get(message.messageId)
          if (callback) {
            this.messageCallbacks.delete(message.messageId)
            callback.resolve(message)
            return
          }
        }

        if (this.streamingBufferIds.has(message.bufferId)) {
          // streaming buffer 不使用事件通道；INITIALIZE 残留响应只是版本错位的历史噪声。
          return
        }

        const buffer = this.buffers.get(message.bufferId)
        if (!buffer || !buffer.hasParser) {
          return
        }

        if (buffer.version !== message.version) {
          // 初始响应落后于 mirror 时只能请求现有 reset 合同，不能提交过期 highlights。
          this.resetBuffer(message.bufferId, buffer.version, buffer.content)
          return
        }

        this.emit("highlights:response", message.bufferId, message.version, message.highlights)
        return
      }

      case "INIT_RESPONSE": {
        if (!this.initializeResolvers) {
          return
        }

        clearTimeout(this.initializeResolvers.timeoutId)

        if (message.error) {
          console.error("TreeSitter client initialization failed:", message.error)
          this.initializeResolvers.reject(new Error(message.error))
        } else {
          this.initializeResolvers.resolve()
        }

        this.initializeResolvers = undefined
        return
      }

      case "PARSER_INIT_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ hasParser: message.hasParser, warning: message.warning, error: message.error })
        }
        return
      }

      case "PRELOAD_PARSER_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ hasParser: message.hasParser })
        }
        return
      }

      case "BUFFER_DISPOSED": {
        // 只有 worker 回应自己的 id，client 才能确认 parser-owned Tree 已离开。
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve(true)
        }

        this.emit("buffer:disposed", message.bufferId)
        return
      }

      case "PERFORMANCE_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve(message.performance)
        }
        return
      }

      case "ONESHOT_HIGHLIGHT_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ highlights: message.highlights, warning: message.warning, error: message.error })
        }
        return
      }

      case "UPDATE_DATA_PATH_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ error: message.error })
        }
        return
      }

      case "CLEAR_CACHE_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ error: message.error })
        }
        return
      }

      case "STREAMING_UPDATE_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({
            version: message.version,
            changedStart: message.changedStart,
            tailStart: message.tailStart,
            highlights: message.highlights,
            error: message.error,
          })
        }
        return
      }

      case "WARNING": {
        // 可等待 warning 不是广播事件：先拒绝对应请求，再保留一次可观察诊断。
        if (message.messageId) {
          const callback = this.messageCallbacks.get(message.messageId)
          if (callback) {
            this.messageCallbacks.delete(message.messageId)
            const warning = new Error(message.warning)
            warning.name = "TreeSitterWorkerWarning"
            callback.reject(warning)
            this.emitWarning(message.warning, message.bufferId)
            return
          }
        }
        this.emitWarning(message.warning, message.bufferId)
        return
      }

      case "ERROR": {
        // 相关错误必须结束原请求；单独 emit 会让 Code 一直等到 destroy 才显示正文。
        if (message.messageId) {
          const callback = this.messageCallbacks.get(message.messageId)
          if (callback) {
            this.messageCallbacks.delete(message.messageId)
            callback.reject(new Error(message.error))
            this.emitError(message.error, message.bufferId)
            return
          }
        }
        this.emitError(message.error, message.bufferId)
        return
      }

      case "WORKER_LOG": {
        this.emit("worker:log", message.logType, message.data.join(" "))
        return
      }
    }
  }

  public async preloadParser(filetype: string): Promise<boolean> {
    const messageId = `has_parser_${this.messageIdCounter++}`
    const response = await new Promise<{ hasParser: boolean; warning?: string; error?: string }>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({
          type: "PRELOAD_PARSER",
          filetype,
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return response.hasParser
  }

  public async createBuffer(
    id: number,
    content: string,
    filetype: string,
    version: number = 1,
    autoInitialize: boolean = true,
  ): Promise<boolean> {
    if (!this.initialized && !autoInitialize) {
      // autoInitialize=false 是调用方明确选择的非启动路径，保持原有可诊断失败而不排队。
      this.emitError("Could not create buffer because client is not initialized")
      return false
    }

    if (this.buffers.has(id)) throw new Error(`Buffer with id ${id} already exists`)

    // 先占位再排队，允许紧随其后的 update/remove 共享同一个生命周期尾部。
    const reservation: BufferState = { id, content, filetype, version, hasParser: false }
    this.buffers.set(id, reservation)
    let accepted = false
    try {
      return await this.enqueueBufferOperation(id, async () => {
        // 初始化也属于该 buffer 的首个操作，不能在队列外发布 parser state。
        if (!this.initialized) {
          try {
            await this.initialize()
          } catch {
            // 初始化失败时不保留 reservation，否则后续调用会误认为 buffer 仍可继续推进。
            this.emitError("Could not create buffer because of initialization error")
            return false
          }
        }

        const messageId = `init_${this.messageIdCounter++}`
        const response = await this.request<{ hasParser: boolean; warning?: string; error?: string }>(messageId, {
          type: "INITIALIZE_PARSER",
          bufferId: id,
          version,
          content,
          filetype,
          messageId,
        })

        if (!response.hasParser) {
          // 无 parser 是正常的能力结果，reservation 仍保留既有非解析 buffer 合同。
          accepted = true
          this.emit("buffer:initialized", id, false)
          if (filetype !== "plaintext") {
            this.emitWarning(response.warning || response.error || "Buffer has no parser", id)
          }
          return false
        }

        accepted = true
        // 只有 correlated init 成功后才把 reservation 换成可解析 mirror。
        this.buffers.set(id, { id, content, filetype, version, hasParser: true })
        this.emit("buffer:initialized", id, true)
        return true
      })
    } finally {
      if (!accepted && this.buffers.get(id) === reservation) this.buffers.delete(id)
    }
  }

  public async updateBuffer(id: number, edits: Edit[], newContent: string, version: number): Promise<void> {
    // 编辑必须等待 create 的终态，不能把未安装的 parser 当作已可写状态。
    if (!this.buffers.has(id) && !this.bufferOperations.has(id)) return
    await this.enqueueBufferOperation(id, async () => {
      const buffer = this.buffers.get(id)
      if (!this.initialized || !buffer?.hasParser) return
      // callback response 之前不更新 mirror，后续 dispose 才能等待真实 mutation 终态。
      await this.processEdit(id, edits, newContent, version)
    })
  }

  // streaming buffer 使用负数 ID 段，避免与编辑器侧的正数 buffer ID 冲突。
  private streamingBufferIdCounter = 0
  // streaming buffer 的高亮走 awaitable 响应而不是 highlights:response 事件；
  // INITIALIZE 遗留的 initialQuery 响应若进入 mismatch-reset 会白做一次全文重解析。
  private streamingBufferIds = new Set<number>()

  public async createStreamingBuffer(content: string, filetype: string): Promise<number | null> {
    // 复用 createBuffer 的 INITIALIZE_PARSER 协议，不为 streaming 引入第二种 parser 初始化路径。
    const id = --this.streamingBufferIdCounter
    // 用空内容初始化：紧随的第一次 streaming update 才提供真实内容与 highlights，
    // 避免 INITIALIZE_PARSER 遗留的 initialQuery 在 worker 里重复做一次全文 query+injections。
    const created = await this.createBuffer(id, "", filetype)
    if (!created) return null
    // createBuffer 记录了空内容，立即把调用方内容写入状态，第一次 update 的 diff 才是全文。
    const buffer = this.buffers.get(id)
    if (buffer) this.buffers.set(id, { ...buffer, content })
    this.streamingBufferIds.add(id)
    return id
  }

  public async updateStreamingBuffer(id: number, content: string, cacheEnd: number): Promise<StreamingUpdateResult> {
    // streaming 与普通编辑共用尾部，保证同一 buffer 不会并行转移两个 Tree owner。
    return this.enqueueBufferOperation(id, async () => {
      const buffer = this.buffers.get(id)
      if (!buffer || !buffer.hasParser) {
        // 没有 parser 的 streaming buffer 没有合法响应通道，直接拒绝调用方。
        // 与 createBuffer 的既有错误表面一致：没有 parser 的 buffer 不能静默成功。
        throw new Error("Streaming buffer has no parser")
      }

      // version 由 client 统一递增，调用方不自带序号，避免多个 producer 对同一 buffer 产生版本分叉。
      const version = buffer.version + 1
      // response 的 version 是 worker 接受的版本，不能用发送时的本地猜测替代它。
      const messageId = `streaming_${this.messageIdCounter++}`
      const response = await this.request<{
        version: number
        changedStart?: number
        tailStart?: number
        highlights?: SimpleHighlight[]
        error?: string
      }>(messageId, { type: "STREAMING_UPDATE", bufferId: id, version, content, cacheEnd, messageId })

      if (response.error) {
        // worker error 已由 request() 相关 reject 转成异常，这个字段只覆盖协议内的显式失败响应。
        // worker 侧失败作为 rejection 交给 Code 的既有 plain-text 兼容路径，而不是成功形态的空结果。
        throw new Error(response.error)
      }

      const current = this.buffers.get(id)
      if (!current || !current.hasParser) throw new Error("Streaming buffer was removed before acceptance")
      // worker acknowledgement 到达后才提交内容和版本，失败时保留上一个可用 mirror。
      this.buffers.set(id, { ...current, content, version: response.version })
      return {
        version: response.version,
        changedStart: response.changedStart ?? 0,
        tailStart: response.tailStart ?? 0,
        highlights: response.highlights ?? [],
        stale: false,
      }
    })
  }

  public async removeStreamingBuffer(id: number): Promise<void> {
    // streaming 标记必须等普通 remove 完成，避免 worker ack 前被另一条路径重新解释。
    // 与编辑器 buffer 共用同一条 DISPOSE 协议与清理逻辑，不引入第二条释放路径。
    return this.removeBuffer(id)
  }

  private async processEdit(
    bufferId: number,
    edits: Edit[],
    newContent: string,
    version: number,
    isReset = false,
  ): Promise<void> {
    // edit/reset 使用同一响应类型，使 worker 错误与成功高亮都完成同一个 request channel。
    const messageId = `${isReset ? "reset" : "edit"}_${this.messageIdCounter++}`
    const response = await this.request<EditResponse>(
      messageId,
      isReset
        ? { type: "RESET_BUFFER", bufferId, version, content: newContent, edits, messageId }
        : { type: "HANDLE_EDITS", bufferId, version, content: newContent, edits, messageId },
    )
    if (response.error) throw new Error(response.error)

    const buffer = this.buffers.get(bufferId)
    if (!buffer || !buffer.hasParser) throw new Error("Buffer was removed before acceptance")
    // 本地 mirror 只在 correlated worker response 后推进，避免下一个操作读到未解析内容。
    this.buffers.set(bufferId, { ...buffer, content: newContent, version })
    // 事件也必须在 mirror commit 后发出，消费者看到的 version 与内容才是一致快照。
    this.emit("highlights:response", bufferId, version, response.highlights ?? [])
  }

  public async removeBuffer(bufferId: number): Promise<void> {
    // 未初始化的无状态 remove 直接返回；已有 reservation/operation 则必须继续走释放尾部。
    if (!this.initialized && !this.buffers.has(bufferId) && !this.bufferOperations.has(bufferId)) return

    await this.enqueueBufferOperation(
      bufferId,
      async () => {
        // disposal 是尾部操作；即使前一个 mutation reject，也必须实际发送释放请求。
        if (!this.initialized || !this.worker) return
        const messageId = `dispose_${bufferId}_${this.messageIdCounter++}`
        await this.request(messageId, { type: "DISPOSE_BUFFER", bufferId, messageId })
      },
      true,
    )
    // 删除 mirror 的时机晚于 BUFFER_DISPOSED ack，不能用旧 timer 制造释放成功。
    this.buffers.delete(bufferId)
    // ack 后移除 streaming 标记，晚到的无 id 初始高亮不会再被当成有效事件。
    this.streamingBufferIds.delete(bufferId)
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise
    }

    let resolveDestroy!: () => void
    let rejectDestroy!: (error: unknown) => void
    const destroyPromise = new Promise<void>((resolve, reject) => {
      resolveDestroy = resolve
      rejectDestroy = reject
    })
    this.destroyPromise = destroyPromise

    const destroyError = new Error("TreeSitter client destroyed")
    this.lifecycleGeneration++
    this.initialized = false
    this.initializePromise = undefined
    this.rejectActiveInitialization(destroyError)
    this.rejectPendingRequests(destroyError)

    for (const callback of this.destroyCallbacks) {
      try {
        callback()
      } catch (error) {
        console.error("TreeSitter client destroy callback failed:", error)
      }
    }
    this.destroyCallbacks.clear()

    // destroy 是唯一可以同时取消所有 buffer tail 的终态，避免正常 mutation 借此伪造成功。
    this.bufferOperations.clear()
    this.buffers.clear()

    void this.stopWorker().then(
      () => {
        this.workerTerminationFailed = false
        if (this.destroyPromise === destroyPromise) {
          this.destroyPromise = undefined
        }
        resolveDestroy()
      },
      (error) => {
        this.workerTerminationFailed = true
        if (this.destroyPromise === destroyPromise) {
          this.destroyPromise = undefined
        }
        rejectDestroy(error)
      },
    )
    return destroyPromise
  }

  public async resetBuffer(bufferId: number, version: number, content: string): Promise<void> {
    // reset 也要识别尚未完成的 create reservation，避免并发调用绕过生命周期序列。
    if (!this.buffers.has(bufferId) && !this.bufferOperations.has(bufferId)) {
      this.emitError("Cannot reset buffer with no parser", bufferId)
      return
    }
    await this.enqueueBufferOperation(bufferId, async () => {
      // reset 不再使用独立 debounce；它必须与 edit 和 dispose 共享同一顺序合同。
      const buffer = this.buffers.get(bufferId)
      if (!this.initialized || !buffer?.hasParser) {
        // queued reset 可能在 create 失败后执行，此时只发出已有 error 事件而不写 mirror。
        this.emitError("Cannot reset buffer with no parser", bufferId)
        return
      }
      await this.processEdit(bufferId, [], content, version, true)
    })
  }

  public getBuffer(bufferId: number): BufferState | undefined {
    return this.buffers.get(bufferId)
  }

  public getAllBuffers(): BufferState[] {
    return Array.from(this.buffers.values())
  }

  public isInitialized(): boolean {
    return this.initialized
  }

  public async setDataPath(dataPath: string): Promise<void> {
    if (this.options.dataPath === dataPath) {
      return
    }

    this.options.dataPath = dataPath

    if (this.initialized && this.worker) {
      const messageId = `update_datapath_${this.messageIdCounter++}`
      return new Promise<void>((resolve, reject) => {
        this.messageCallbacks.set(messageId, {
          resolve: (response) => {
            const result = response as { error?: string }
            if (result.error) {
              reject(new Error(result.error))
            } else {
              resolve()
            }
          },
          reject,
        })
        try {
          this.sendWorkerMessage({
            type: "UPDATE_DATA_PATH",
            dataPath,
            messageId,
          })
        } catch (error) {
          this.messageCallbacks.delete(messageId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
  }

  public async clearCache(): Promise<void> {
    if (!this.initialized || !this.worker) {
      throw new Error("Cannot clear cache: client is not initialized")
    }

    const messageId = `clear_cache_${this.messageIdCounter++}`
    return new Promise<void>((resolve, reject) => {
      this.messageCallbacks.set(messageId, {
        resolve: (response) => {
          const result = response as { error?: string }
          if (result.error) {
            reject(new Error(result.error))
          } else {
            resolve()
          }
        },
        reject,
      })
      try {
        this.sendWorkerMessage({
          type: "CLEAR_CACHE",
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
