export interface HighlightRange {
  startCol: number
  endCol: number
  group: string
}

export interface HighlightResponse {
  line: number
  highlights: HighlightRange[]
  droppedHighlights: HighlightRange[]
}

export interface HighlightMeta {
  isInjection?: boolean
  injectionLang?: string
  containsInjection?: boolean
  conceal?: string | null // Value from (#set! conceal "...") predicate
  concealLines?: string | null // Value from (#set! conceal_lines "...") predicate - indicates the whole line should be concealed
}

export type SimpleHighlight = [number, number, string, HighlightMeta?]

export interface InjectionMapping {
  // Maps tree-sitter node types to target filetypes
  nodeTypes?: { [nodeType: string]: string }
  // Maps info string content (e.g., from code blocks) to target filetypes
  infoStringMap?: { [infoString: string]: string }
}

export interface FiletypeParserOptions {
  filetype: string
  aliases?: string[]
  queries: {
    highlights: string[] // Array of URLs or local file paths to fetch highlight queries from
    injections?: string[] // Array of URLs or local file paths to fetch injection queries from
  }
  wasm: string // URL or local file path to the language parser WASM file
  injectionMapping?: InjectionMapping // Optional mapping for injection handling
}

export interface StreamingUpdateResult {
  version: number
  // 以下偏移全部使用已观察的 web-tree-sitter JavaScript UTF-16 code-unit 域，禁止按 UTF-8 byte 理解。
  changedStart: number
  // tailStart 是 parser 给出的唯一缓存资格边界：之前的 block 已闭合，之后的内容每帧全量重转。
  tailStart: number
  highlights: SimpleHighlight[]
  // stale 表示响应期间 owner 已转移或有更新版本提交；调用方必须丢弃而不是提交或报错。
  stale?: boolean
}

export interface BufferState {
  id: number
  version: number
  content: string
  filetype: string
  hasParser: boolean
}

export interface ParsedBuffer extends BufferState {
  hasParser: true
}

export type TreeSitterWorkerLogType = "log" | "error" | "warn"

// 可等待的 mutation 必须沿同一 id 返回终态，避免 worker 异常把调用方 Promise 留到 destroy。
export type TreeSitterWorkerRequest =
  | { type: "INIT"; dataPath: string }
  | { type: "ADD_FILETYPE_PARSER"; filetypeParser: FiletypeParserOptions }
  | { type: "PRELOAD_PARSER"; filetype: string; messageId: string }
  | {
      type: "INITIALIZE_PARSER"
      bufferId: number
      version: number
      content: string
      filetype: string
      messageId: string
    }
  | { type: "HANDLE_EDITS"; bufferId: number; version: number; content: string; edits: Edit[]; messageId: string }
  | { type: "GET_PERFORMANCE"; messageId: string }
  | { type: "RESET_BUFFER"; bufferId: number; version: number; content: string; edits: Edit[]; messageId: string }
  | {
      type: "STREAMING_UPDATE"
      bufferId: number
      version: number
      content: string
      // cacheEnd 是调用方已缓存前缀的终点，worker 只需返回该点之后变化的 highlights。
      cacheEnd: number
      messageId: string
    }
  // dispose 的 messageId 让释放确认与同 buffer 的 mutation 串在同一生命周期上。
  | { type: "DISPOSE_BUFFER"; bufferId: number; messageId: string }
  | { type: "ONESHOT_HIGHLIGHT"; content: string; filetype: string; messageId: string }
  | { type: "UPDATE_DATA_PATH"; dataPath: string; messageId: string }
  | { type: "CLEAR_CACHE"; messageId: string }

// 响应类型同时承载事件和可等待请求；只有带 messageId 的分支才负责 Promise 终态。
export type TreeSitterWorkerResponse =
  | { type: "INIT_RESPONSE"; error?: string }
  | {
      type: "PARSER_INIT_RESPONSE"
      bufferId: number
      messageId: string
      hasParser: boolean
      warning?: string
      error?: string
    }
  | {
      type: "HIGHLIGHT_RESPONSE"
      bufferId: number
      version: number
      highlights: HighlightResponse[]
      messageId?: string
    }
  | { type: "PRELOAD_PARSER_RESPONSE"; messageId: string; hasParser: boolean }
  | { type: "BUFFER_DISPOSED"; bufferId: number; messageId: string }
  | { type: "PERFORMANCE_RESPONSE"; performance: PerformanceStats; messageId: string }
  | {
      type: "ONESHOT_HIGHLIGHT_RESPONSE"
      messageId: string
      hasParser: boolean
      highlights?: SimpleHighlight[]
      warning?: string
      error?: string
    }
  | {
      type: "STREAMING_UPDATE_RESPONSE"
      bufferId: number
      version: number
      messageId: string
      changedStart?: number
      tailStart?: number
      highlights?: SimpleHighlight[]
      error?: string
    }
  | { type: "UPDATE_DATA_PATH_RESPONSE"; messageId: string; error?: string }
  | { type: "CLEAR_CACHE_RESPONSE"; messageId: string; error?: string }
  | { type: "WARNING"; bufferId?: number; messageId?: string; warning: string }
  | { type: "ERROR"; bufferId?: number; messageId?: string; error: string }
  | { type: "WORKER_LOG"; logType: TreeSitterWorkerLogType; data: unknown[] }

export interface TreeSitterClientEvents {
  "highlights:response": [bufferId: number, version: number, highlights: HighlightResponse[]]
  "buffer:initialized": [bufferId: number, hasParser: boolean]
  "buffer:disposed": [bufferId: number]
  "worker:log": [logType: TreeSitterWorkerLogType, message: string]
  error: [error: string, bufferId?: number]
  warning: [warning: string, bufferId?: number]
}

export interface TreeSitterClientOptions {
  dataPath: string // Directory for storing downloaded parsers and queries
  workerPath?: string | URL
  initTimeout?: number // Timeout in milliseconds for worker initialization, defaults to 10000
}

export interface Edit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: { row: number; column: number }
  oldEndPosition: { row: number; column: number }
  newEndPosition: { row: number; column: number }
}

export interface PerformanceStats {
  averageParseTime: number
  parseTimes: number[]
  averageQueryTime: number
  queryTimes: number[]
}
