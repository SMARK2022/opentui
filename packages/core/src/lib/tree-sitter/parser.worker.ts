import { Parser, Query, Tree, Language } from "web-tree-sitter"
import type { Edit, QueryCapture, Range } from "web-tree-sitter"
import { mkdir } from "fs/promises"
import * as path from "path"
import type {
  HighlightRange,
  HighlightResponse,
  SimpleHighlight,
  FiletypeParserOptions,
  PerformanceStats,
  InjectionMapping,
  TreeSitterWorkerLogType,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResponse,
} from "./types.js"
import { DownloadUtils } from "./download-utils.js"
import { isBunfsPath, normalizeBunfsPath } from "../bunfs.js"
import { resolveBundledFilePath } from "../../platform/runtime.js"
import {
  isWorkerRuntime,
  postWorkerMessage,
  setWorkerMessageHandler,
  type WorkerMessageEvent,
} from "../../platform/worker.js"

type ParserState = {
  parser: Parser
  tree: Tree
  queries: {
    highlights: Query
    injections?: Query
  }
  filetype: string
  content: string
  injectionMapping?: InjectionMapping
  // streaming 引用链接状态：block 起点 -> 该 block 内出现的未解析 label 集合。
  // 定义晚于用法到达是流式常态，只有定义到达后用法所在 block 才能进入稳定前缀。
  referenceUsages?: Map<number, Set<string>>
  referenceDefinitions?: Map<number, string>
  // 首次扫描必须覆盖全文；之后按编辑点增量维护，否则初始内容里的未解析引用会被漏掉。
  referencesInitialized?: boolean
}

interface FiletypeParser {
  filetype: string
  queries: {
    highlights: Query
    injections?: Query
  }
  language: Language
  injectionMapping?: InjectionMapping
}

interface ReusableParserState {
  parser: Parser
  filetypeParser: FiletypeParser
  queries: {
    highlights: Query
    injections?: Query
  }
}

class ParserWorker {
  private bufferParsers: Map<number, ParserState> = new Map()
  private filetypeParserOptions: Map<string, FiletypeParserOptions> = new Map()
  private filetypeAliases: Map<string, string> = new Map()
  private filetypeParsers: Map<string, FiletypeParser> = new Map()
  private filetypeParserPromises: Map<string, Promise<FiletypeParser | undefined>> = new Map()
  private reusableParsers: Map<string, ReusableParserState> = new Map()
  private reusableParserPromises: Map<string, Promise<ReusableParserState | undefined>> = new Map()
  private initializePromise: Promise<void> | undefined
  public performance: PerformanceStats
  private dataPath: string | undefined
  private tsDataPath: string | undefined
  private initialized: boolean = false

  constructor() {
    this.performance = {
      averageParseTime: 0,
      parseTimes: [],
      averageQueryTime: 0,
      queryTimes: [],
    }
  }

  private async fetchQueries(sources: string[], filetype: string): Promise<string> {
    if (!this.tsDataPath) {
      return ""
    }
    return DownloadUtils.fetchHighlightQueries(sources, this.tsDataPath, filetype)
  }

  async initialize({ dataPath }: { dataPath: string }) {
    if (this.initializePromise) {
      return this.initializePromise
    }
    this.initializePromise = (async () => {
      this.dataPath = dataPath
      this.tsDataPath = path.join(dataPath, "tree-sitter")

      await mkdir(path.join(this.tsDataPath, "languages"), { recursive: true })
      await mkdir(path.join(this.tsDataPath, "queries"), { recursive: true })

      let treeWasm = await resolveBundledFilePath(
        () => import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } }),
        () => import.meta.resolve("web-tree-sitter/tree-sitter.wasm"),
        import.meta.url,
      )

      if (isBunfsPath(treeWasm)) {
        treeWasm = normalizeBunfsPath(path.parse(treeWasm).base)
      }

      await Parser.init({
        locateFile() {
          return treeWasm
        },
      })

      this.initialized = true
    })()
    return this.initializePromise
  }

  public addFiletypeParser(filetypeParser: FiletypeParserOptions) {
    const previousAliases = this.filetypeParserOptions.get(filetypeParser.filetype)?.aliases ?? []
    for (const alias of previousAliases) {
      if (this.filetypeAliases.get(alias) === filetypeParser.filetype) {
        this.filetypeAliases.delete(alias)
      }
    }

    const aliases = [...new Set((filetypeParser.aliases ?? []).filter((alias) => alias !== filetypeParser.filetype))]

    this.filetypeAliases.delete(filetypeParser.filetype)
    this.filetypeParserOptions.set(filetypeParser.filetype, {
      ...filetypeParser,
      aliases,
    })

    for (const alias of aliases) {
      this.filetypeAliases.set(alias, filetypeParser.filetype)
    }

    this.invalidateParserCaches(filetypeParser.filetype)
  }

  private resolveCanonicalFiletype(filetype: string): string {
    if (this.filetypeParserOptions.has(filetype)) {
      return filetype
    }

    return this.filetypeAliases.get(filetype) ?? filetype
  }

  private invalidateParserCaches(filetype: string): void {
    this.filetypeParsers.delete(filetype)
    this.filetypeParserPromises.delete(filetype)

    const reusableParser = this.reusableParsers.get(filetype)
    if (reusableParser) {
      reusableParser.parser.delete()
      this.reusableParsers.delete(filetype)
    }

    this.reusableParserPromises.delete(filetype)
  }

  private async createQueries(
    filetypeParser: FiletypeParserOptions,
    language: Language,
  ): Promise<
    | {
        highlights: Query
        injections?: Query
      }
    | undefined
  > {
    try {
      const highlightQueryContent = await this.fetchQueries(filetypeParser.queries.highlights, filetypeParser.filetype)
      if (!highlightQueryContent) {
        console.error("Failed to fetch highlight queries for:", filetypeParser.filetype)
        return undefined
      }

      const highlightsQuery = new Query(language, highlightQueryContent)
      const result: { highlights: Query; injections?: Query } = {
        highlights: highlightsQuery,
      }

      if (filetypeParser.queries.injections && filetypeParser.queries.injections.length > 0) {
        const injectionQueryContent = await this.fetchQueries(
          filetypeParser.queries.injections,
          filetypeParser.filetype,
        )
        if (injectionQueryContent) {
          result.injections = new Query(language, injectionQueryContent)
        }
      }

      return result
    } catch (error) {
      console.error("Error creating queries for", filetypeParser.filetype, filetypeParser.queries)
      console.error(error)
      return undefined
    }
  }

  private async loadLanguage(languageSource: string): Promise<Language | undefined> {
    if (!this.initialized || !this.tsDataPath) {
      return undefined
    }

    const result = await DownloadUtils.downloadOrLoad(languageSource, this.tsDataPath, "languages", ".wasm", false)

    if (result.error) {
      console.error(`Error loading language ${languageSource}:`, result.error)
      return undefined
    }

    if (!result.filePath) {
      return undefined
    }

    // Normalize path for Windows compatibility - tree-sitter expects forward slashes
    const normalizedPath = result.filePath.replaceAll("\\", "/")

    try {
      const language = await Language.load(normalizedPath)
      return language
    } catch (error) {
      console.error(`Error loading language from ${normalizedPath}:`, error)
      return undefined
    }
  }

  private async resolveFiletypeParser(filetype: string): Promise<FiletypeParser | undefined> {
    const canonicalFiletype = this.resolveCanonicalFiletype(filetype)

    if (this.filetypeParsers.has(canonicalFiletype)) {
      return this.filetypeParsers.get(canonicalFiletype)
    }

    if (this.filetypeParserPromises.has(canonicalFiletype)) {
      return this.filetypeParserPromises.get(canonicalFiletype)
    }

    const loadingPromise = this.loadFiletypeParser(canonicalFiletype)
    this.filetypeParserPromises.set(canonicalFiletype, loadingPromise)

    try {
      const result = await loadingPromise
      if (result) {
        this.filetypeParsers.set(canonicalFiletype, result)
      }
      return result
    } finally {
      this.filetypeParserPromises.delete(canonicalFiletype)
    }
  }

  private async loadFiletypeParser(filetype: string): Promise<FiletypeParser | undefined> {
    const filetypeParserOptions = this.filetypeParserOptions.get(filetype)
    if (!filetypeParserOptions) {
      return undefined
    }
    const language = await this.loadLanguage(filetypeParserOptions.wasm)
    if (!language) {
      return undefined
    }
    const queries = await this.createQueries(filetypeParserOptions, language)
    if (!queries) {
      console.error("Failed to create queries for:", filetype)
      return undefined
    }
    const filetypeParser: FiletypeParser = {
      ...filetypeParserOptions,
      queries,
      language,
    }
    return filetypeParser
  }

  public async preloadParser(filetype: string) {
    return this.resolveFiletypeParser(filetype)
  }

  private async getReusableParser(filetype: string): Promise<ReusableParserState | undefined> {
    const canonicalFiletype = this.resolveCanonicalFiletype(filetype)

    if (this.reusableParsers.has(canonicalFiletype)) {
      return this.reusableParsers.get(canonicalFiletype)
    }

    if (this.reusableParserPromises.has(canonicalFiletype)) {
      return this.reusableParserPromises.get(canonicalFiletype)
    }

    const creationPromise = this.createReusableParser(canonicalFiletype)
    this.reusableParserPromises.set(canonicalFiletype, creationPromise)

    try {
      const result = await creationPromise
      if (result) {
        this.reusableParsers.set(canonicalFiletype, result)
      }
      return result
    } finally {
      this.reusableParserPromises.delete(canonicalFiletype)
    }
  }

  private async createReusableParser(filetype: string): Promise<ReusableParserState | undefined> {
    const filetypeParser = await this.resolveFiletypeParser(filetype)
    if (!filetypeParser) {
      return undefined
    }

    const parser = new Parser()
    parser.setLanguage(filetypeParser.language)

    const reusableState: ReusableParserState = {
      parser,
      filetypeParser,
      queries: filetypeParser.queries,
    }

    return reusableState
  }

  async handleInitializeParser(
    bufferId: number,
    version: number,
    content: string,
    filetype: string,
    messageId: string,
  ) {
    const filetypeParser = await this.resolveFiletypeParser(filetype)

    if (!filetypeParser) {
      postWorkerMessage({
        type: "PARSER_INIT_RESPONSE",
        bufferId,
        messageId,
        hasParser: false,
        warning: `No parser available for filetype ${filetype}`,
      })
      return
    }

    const parser = new Parser()
    parser.setLanguage(filetypeParser.language)
    const tree = parser.parse(content)
    if (!tree) {
      postWorkerMessage({
        type: "PARSER_INIT_RESPONSE",
        bufferId,
        messageId,
        hasParser: false,
        error: "Failed to parse buffer",
      })
      return
    }

    const parserState: ParserState = {
      parser,
      tree,
      queries: filetypeParser.queries,
      filetype,
      content,
      injectionMapping: filetypeParser.injectionMapping,
    }
    this.bufferParsers.set(bufferId, parserState)

    postWorkerMessage({
      type: "PARSER_INIT_RESPONSE",
      bufferId,
      messageId,
      hasParser: true,
    })
    const highlights = await this.initialQuery(parserState)
    postWorkerMessage({
      type: "HIGHLIGHT_RESPONSE",
      bufferId,
      version,
      ...highlights,
    })
  }

  private async initialQuery(parserState: ParserState) {
    const query = parserState.queries.highlights
    const matches: QueryCapture[] = query.captures(parserState.tree.rootNode)
    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()

    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  private getNodeText(node: any, content: string): string {
    return content.substring(node.startIndex, node.endIndex)
  }

  private async processInjections(
    parserState: ParserState,
    fromIndex?: number,
  ): Promise<{ captures: QueryCapture[]; injectionRanges: Map<string, Array<{ start: number; end: number }>> }> {
    const injectionMatches: QueryCapture[] = []
    const injectionRanges = new Map<string, Array<{ start: number; end: number }>>()

    if (!parserState.queries.injections) {
      return { captures: injectionMatches, injectionRanges }
    }

    const content = parserState.content
    // streaming 更新只处理 tail 区域的 injection；前缀的 inline/code fence 内容未变，重解析是纯浪费。
    const injectionCaptures = this.capturesFrom(parserState.queries.injections, parserState.tree.rootNode, fromIndex ?? 0)
    const languageGroups = new Map<string, Array<{ node: any; name: string }>>()

    // Use the injection mapping stored in the parser state
    const injectionMapping = parserState.injectionMapping

    for (const capture of injectionCaptures) {
      const captureName = capture.name

      if (captureName === "injection.content" || captureName.includes("injection")) {
        const nodeType = capture.node.type
        let targetLanguage: string | undefined

        // First, check if there's a direct node type mapping
        if (injectionMapping?.nodeTypes && injectionMapping.nodeTypes[nodeType]) {
          targetLanguage = injectionMapping.nodeTypes[nodeType]
        } else if (nodeType === "code_fence_content") {
          // For code fence content, try to extract language from info_string
          const parent = capture.node.parent
          if (parent) {
            const infoString = parent.children.find((child: any) => child.type === "info_string")
            if (infoString) {
              const languageNode = infoString.children.find((child: any) => child.type === "language")
              if (languageNode) {
                const languageName = this.getNodeText(languageNode, content)

                if (injectionMapping?.infoStringMap && injectionMapping.infoStringMap[languageName]) {
                  targetLanguage = injectionMapping.infoStringMap[languageName]
                } else {
                  targetLanguage = languageName
                }
              }
            }
          }
        }

        if (targetLanguage) {
          if (!languageGroups.has(targetLanguage)) {
            languageGroups.set(targetLanguage, [])
          }
          languageGroups.get(targetLanguage)!.push({ node: capture.node, name: capture.name })
        }
      }
    }

    // Process each language group
    for (const [language, captures] of languageGroups.entries()) {
      const injectedParser = await this.getReusableParser(language)

      if (!injectedParser) {
        console.warn(`No parser found for injection language: ${language}`)
        continue
      }

      // Track injection ranges for this language
      if (!injectionRanges.has(language)) {
        injectionRanges.set(language, [])
      }

      const parser = injectedParser.parser
      for (const { node: injectionNode } of captures) {
        try {
          // Record the injection range
          injectionRanges.get(language)!.push({
            start: injectionNode.startIndex,
            end: injectionNode.endIndex,
          })

          const injectionContent = this.getNodeText(injectionNode, content)
          const tree = parser.parse(injectionContent)

          if (tree) {
            const matches = injectedParser.queries.highlights.captures(tree.rootNode)

            // Create new QueryCapture objects with offset positions
            for (const match of matches) {
              // Calculate offset positions by creating a new capture with adjusted node properties
              // Store the injected query reference so we can look up properties correctly
              const offsetCapture: QueryCapture & { _injectedQuery?: Query } = {
                name: match.name,
                patternIndex: match.patternIndex,
                _injectedQuery: injectedParser.queries.highlights, // Store the correct query reference
                node: {
                  ...match.node,
                  startPosition: {
                    row: match.node.startPosition.row + injectionNode.startPosition.row,
                    column:
                      match.node.startPosition.row === 0
                        ? match.node.startPosition.column + injectionNode.startPosition.column
                        : match.node.startPosition.column,
                  },
                  endPosition: {
                    row: match.node.endPosition.row + injectionNode.startPosition.row,
                    column:
                      match.node.endPosition.row === 0
                        ? match.node.endPosition.column + injectionNode.startPosition.column
                        : match.node.endPosition.column,
                  },
                  startIndex: match.node.startIndex + injectionNode.startIndex,
                  endIndex: match.node.endIndex + injectionNode.startIndex,
                } as any, // Cast to any since we're creating a pseudo-node
              }

              injectionMatches.push(offsetCapture)
            }

            tree.delete()
          }
        } catch (error) {
          console.error(`Error processing injection for language ${language}:`, error)
        }
      }

      // NOTE: Do NOT call parser.delete() here - this is a reusable parser!
    }

    return { captures: injectionMatches, injectionRanges }
  }

  private editToRange(edit: Edit): Range {
    return {
      startPosition: {
        column: edit.startPosition.column,
        row: edit.startPosition.row,
      },
      endPosition: {
        column: edit.newEndPosition.column,
        row: edit.newEndPosition.row,
      },
      startIndex: edit.startIndex,
      endIndex: edit.newEndIndex,
    }
  }

  async handleEdits(
    bufferId: number,
    content: string,
    edits: Edit[],
  ): Promise<{ highlights?: HighlightResponse[]; warning?: string; error?: string }> {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return { warning: "No parser state found for buffer" }
    }

    parserState.content = content

    for (const edit of edits) {
      parserState.tree.edit(edit)
    }

    const startParse = performance.now()

    const newTree = parserState.parser.parse(content, parserState.tree)

    const endParse = performance.now()
    const parseTime = endParse - startParse
    this.performance.parseTimes.push(parseTime)
    if (this.performance.parseTimes.length > 10) {
      this.performance.parseTimes.shift()
    }
    this.performance.averageParseTime =
      this.performance.parseTimes.reduce((acc, time) => acc + time, 0) / this.performance.parseTimes.length

    if (!newTree) {
      return { error: "Failed to parse buffer" }
    }

    const changedRanges = parserState.tree.getChangedRanges(newTree)
    parserState.tree = newTree

    const startQuery = performance.now()
    const matches: QueryCapture[] = []

    if (changedRanges.length === 0) {
      edits.forEach((edit) => {
        const range = this.editToRange(edit)
        changedRanges.push(range)
      })
    }

    for (const range of changedRanges) {
      let node = parserState.tree.rootNode.descendantForPosition(range.startPosition, range.endPosition)

      if (!node) {
        continue
      }

      // If we got the root node, query with range to limit scope
      if (node.equals(parserState.tree.rootNode)) {
        // WHY ARE RANGES NOT WORKING!?
        // The changed ranges are not returning anything in some cases
        // Even this shit somehow returns many lines before the actual range,
        // and even though expanded by 1000 bytes it does not capture much beyond the actual range.
        // So freaking weird.
        const rangeCaptures = parserState.queries.highlights.captures(
          node,
          // WTF!?
          {
            startIndex: range.startIndex - 100,
            endIndex: range.endIndex + 1000,
          },
        )
        matches.push(...rangeCaptures)
        continue
      }

      while (node && !this.nodeContainsRange(node, range)) {
        node = node.parent
      }

      if (!node) {
        node = parserState.tree.rootNode
      }

      const nodeCaptures = parserState.queries.highlights.captures(node)
      matches.push(...nodeCaptures)
    }

    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      // Only add injection matches that are in the changed ranges
      // This is a simplification - ideally we'd only process injections in changed ranges
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    const endQuery = performance.now()
    const queryTime = endQuery - startQuery
    this.performance.queryTimes.push(queryTime)
    if (this.performance.queryTimes.length > 10) {
      this.performance.queryTimes.shift()
    }
    this.performance.averageQueryTime =
      this.performance.queryTimes.reduce((acc, time) => acc + time, 0) / this.performance.queryTimes.length

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  private nodeContainsRange(node: any, range: any): boolean {
    return (
      node.startPosition.row <= range.startPosition.row &&
      node.endPosition.row >= range.endPosition.row &&
      (node.startPosition.row < range.startPosition.row || node.startPosition.column <= range.startPosition.column) &&
      (node.endPosition.row > range.endPosition.row || node.endPosition.column >= range.endPosition.column)
    )
  }

  private getHighlights(
    parserState: ParserState,
    matches: QueryCapture[],
    injectionRanges?: Map<string, Array<{ start: number; end: number }>>,
  ): { highlights: HighlightResponse[] } {
    const lineHighlights: Map<number, Map<number, HighlightRange>> = new Map()
    const droppedHighlights: Map<number, Map<number, HighlightRange>> = new Map()

    for (const match of matches) {
      const node = match.node
      const startLine = node.startPosition.row
      const endLine = node.endPosition.row

      const highlight = {
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        group: match.name,
      }

      if (!lineHighlights.has(startLine)) {
        lineHighlights.set(startLine, new Map())
        droppedHighlights.set(startLine, new Map())
      }
      if (lineHighlights.get(startLine)?.has(node.id)) {
        droppedHighlights.get(startLine)?.set(node.id, lineHighlights.get(startLine)?.get(node.id)!)
      }
      lineHighlights.get(startLine)?.set(node.id, highlight)

      if (startLine !== endLine) {
        for (let line = startLine + 1; line <= endLine; line++) {
          if (!lineHighlights.has(line)) {
            lineHighlights.set(line, new Map())
          }
          const hl: HighlightRange = {
            startCol: 0,
            endCol: node.endPosition.column,
            group: match.name,
          }
          lineHighlights.get(line)?.set(node.id, hl)
        }
      }
    }

    return {
      highlights: Array.from(lineHighlights.entries()).map(([line, lineHighlights]) => ({
        line,
        highlights: Array.from(lineHighlights.values()),
        droppedHighlights: droppedHighlights.get(line) ? Array.from(droppedHighlights.get(line)!.values()) : [],
      })),
    }
  }

  private getSimpleHighlights(
    matches: QueryCapture[],
    injectionRanges: Map<string, Array<{ start: number; end: number }>>,
  ): SimpleHighlight[] {
    const highlights: SimpleHighlight[] = []

    const flatInjectionRanges: Array<{ start: number; end: number; lang: string }> = []
    for (const [lang, ranges] of injectionRanges.entries()) {
      for (const range of ranges) {
        flatInjectionRanges.push({ ...range, lang })
      }
    }

    for (const match of matches) {
      const node = match.node

      let isInjection = false
      let injectionLang: string | undefined
      let containsInjection = false
      for (const injRange of flatInjectionRanges) {
        if (node.startIndex >= injRange.start && node.endIndex <= injRange.end) {
          isInjection = true
          injectionLang = injRange.lang
          break
        } else if (node.startIndex <= injRange.start && node.endIndex >= injRange.end) {
          containsInjection = true
          break
        }
      }

      const matchQuery = (match as any)._injectedQuery
      const patternProperties = matchQuery?.setProperties?.[match.patternIndex]

      const concealValue = patternProperties?.conceal ?? match.setProperties?.conceal
      const concealLines = patternProperties?.conceal_lines ?? match.setProperties?.conceal_lines

      const meta: any = {}
      if (isInjection && injectionLang) {
        meta.isInjection = true
        meta.injectionLang = injectionLang
      }
      if (containsInjection) {
        meta.containsInjection = true
      }
      if (concealValue !== undefined) {
        meta.conceal = concealValue
      }
      if (concealLines !== undefined) {
        meta.concealLines = concealLines
      }

      if (Object.keys(meta).length > 0) {
        highlights.push([node.startIndex, node.endIndex, match.name, meta])
      } else {
        highlights.push([node.startIndex, node.endIndex, match.name])
      }
    }

    highlights.sort((a, b) => a[0] - b[0])

    return highlights
  }

  // 与 one-shot 相同的 markdown 兼容规则：闭合 ``` 后必须存在换行才能解析出闭合节点。
  private normalizeStreamingParseContent(filetype: string, source: string): string {
    return filetype === "markdown" && source.endsWith("```") ? source + "\n" : source
  }

  // web-tree-sitter 的 node index 与 Edit 均使用 JavaScript UTF-16 code-unit 域，diff 直接在字符串上进行。
  // 该结论来自对安装版本的行为探测；一旦误判为 UTF-8 byte 域，CJK/emoji 内容的 edit 会直接撕裂字符。
  private computeCodeUnitEdit(oldContent: string, newContent: string): Edit {
    let start = 0
    const maxStart = Math.min(oldContent.length, newContent.length)
    while (start < maxStart && oldContent[start] === newContent[start]) start++

    // 公共后缀必须从两端同时收缩，否则重叠区间会把同一字符同时计入前缀和后缀。
    let oldEnd = oldContent.length
    let newEnd = newContent.length
    while (oldEnd > start && newEnd > start && oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
      oldEnd--
      newEnd--
    }

    // tree.edit 同时要求 point 坐标；row 按换行数推导，column 是相对行首的 code-unit 距离。
    const positionAt = (content: string, index: number) => {
      let row = 0
      let lineStart = 0
      for (let i = 0; i < index; i++) {
        if (content[i] === "\n") {
          row++
          lineStart = i + 1
        }
      }
      return { row, column: index - lineStart }
    }

    // 单点 diff 足够覆盖 append 与整体 rewrite：tree-sitter 只要求一个连续编辑区间。
    return {
      startIndex: start,
      oldEndIndex: oldEnd,
      newEndIndex: newEnd,
      startPosition: positionAt(oldContent, start),
      oldEndPosition: positionAt(oldContent, oldEnd),
      newEndPosition: positionAt(newContent, newEnd),
    }
  }

  // markdown grammar 的 document/section 是透明容器；稳定边界必须落在 section 内部的最后一个 render block。
  // 选 root child 会把整个 section 钉成 tail，导致已闭合段落在每个 delta 都被全量重转。
  private lastRenderBlockStart(rootNode: any): number {
    let node = rootNode
    while ((node.type === "document" || node.type === "section") && node.namedChildCount > 0) {
      node = node.namedChild(node.namedChildCount - 1)
    }
    // 最后一个 render block 始终属于 tail：只有后续 sibling 出现才能证明它闭合。
    return node === rootNode ? 0 : node.startIndex
  }

  // section 可以按标题层级嵌套，因此收集 render block 时必须递归穿透而不是只看 root children。
  private topLevelBlocks(rootNode: any): any[] {
    const blocks: any[] = []
    const collect = (container: any) => {
      for (const child of container.namedChildren) {
        if (child.type === "section") collect(child)
        else blocks.push(child)
      }
    }
    collect(rootNode)
    return blocks
  }

  // query 的 range 选项在本版本 web-tree-sitter 上不可靠（既有 handleEdits 注释也踩过），
  // 但 markdown 的 highlight/injection 模式都是 block 局部的，逐 block capture 与全量等价且只花 tail 成本。
  private capturesFrom(query: Query, rootNode: any, fromIndex: number): QueryCapture[] {
    // fromIndex 为 0 时是首帧或缓存失效帧：必须全量 capture，结果与 one-shot 完全一致。
    if (fromIndex <= 0) return query.captures(rootNode)
    const matches: QueryCapture[] = []
    for (const block of this.topLevelBlocks(rootNode)) {
      if (block.endIndex <= fromIndex) continue
      matches.push(...query.captures(block))
    }
    return matches
  }

  // 返回最早未解析引用所在的 top-level block 起点；没有未解析引用时返回 undefined。
  // 编辑点之前的内容与 common prefix 逐字相同，那里 block 的引用状态无需重算；
  // 只需丢弃编辑点之后的旧 key 并重扫相交 block，避免非追加编辑退化为全文 inline parse。
  private async updateReferenceState(parserState: ParserState, editStart: number): Promise<number | undefined> {
    const usages = (parserState.referenceUsages ??= new Map())
    const definitions = (parserState.referenceDefinitions ??= new Map())

    if (!parserState.referencesInitialized) {
      parserState.referencesInitialized = true
      editStart = 0
    }

    // 编辑点之后 block 的起点会因文本增删而漂移，旧 key 不再可靠；之前的内容逐字相同，key 保持有效。
    for (const key of [...usages.keys()]) {
      if (key >= editStart) usages.delete(key)
    }
    for (const key of [...definitions.keys()]) {
      if (key >= editStart) definitions.delete(key)
    }

    const blocks = this.topLevelBlocks(parserState.tree.rootNode).filter((block) => block.endIndex > editStart)
    if (blocks.length === 0) return this.earliestUnresolvedBlock(usages, definitions)

    let inlineParser: ReusableParserState | undefined
    for (const block of blocks) {
      // block 被重新扫描时先清除旧记录，避免已删除的引用残留。
      usages.delete(block.startIndex)
      definitions.delete(block.startIndex)

      const inlineNodes: any[] = []
      const walk = (node: any) => {
        if (node.type === "link_reference_definition") {
          const label = node.namedChildren.find((child: any) => child.type === "link_label")
          // CommonMark 的 label 匹配不区分大小写，统一小写存储才能正确判定“已定义”。
          if (label) definitions.set(block.startIndex, label.text.toLowerCase())
          return
        }
        // inline 节点的文本属于 markdown_inline grammar，block 树下钻没有意义，收集后交给 inline parser。
        if (node.type === "inline") {
          inlineNodes.push(node)
          return
        }
        for (const child of node.namedChildren) walk(child)
      }
      walk(block)

      if (inlineNodes.length === 0) continue
      // getReusableParser 有缓存；只有首次需要 inline 解析时才付出 Language 加载成本。
      inlineParser ??= await this.getReusableParser("markdown_inline")
      if (!inlineParser) continue

      for (const inlineNode of inlineNodes) {
        const inlineTree = inlineParser.parser.parse(this.getNodeText(inlineNode, parserState.content))
        if (!inlineTree) continue
        try {
          const collectLabels = (node: any): void => {
            if (
              node.type === "full_reference_link" ||
              node.type === "collapsed_reference_link" ||
              node.type === "shortcut_link"
            ) {
              // full 形式的 label 在 link_label 子节点；collapsed/shortcut 的 label 就是 link_text。
              const labelNode =
                node.type === "full_reference_link"
                  ? node.namedChildren.find((child: any) => child.type === "link_label")
                  : node.namedChildren.find((child: any) => child.type === "link_text")
              if (labelNode) {
                const labels = usages.get(block.startIndex) ?? new Set<string>()
                labels.add(labelNode.text.toLowerCase())
                usages.set(block.startIndex, labels)
              }
            }
            for (const child of node.namedChildren) collectLabels(child)
          }
          collectLabels(inlineTree.rootNode)
        } finally {
          // web-tree-sitter 的 Tree 持有 WASM 堆内存，必须显式 delete，否则每个 delta 都会泄漏。
          inlineTree.delete()
        }
      }
    }

    return this.earliestUnresolvedBlock(usages, definitions)
  }

  private earliestUnresolvedBlock(
    usages: Map<number, Set<string>>,
    definitions: Map<number, string>,
  ): number | undefined {
    const definedLabels = new Set([...definitions.values()])
    let earliest: number | undefined
    for (const [blockStart, labels] of usages) {
      for (const label of labels) {
        if (definedLabels.has(label)) continue
        // 同一 block 只要还有一个 label 未定义，它的链接渲染就可能随后续定义改变，不可进入稳定前缀。
        earliest = earliest === undefined ? blockStart : Math.min(earliest, blockStart)
        break
      }
    }
    return earliest
  }

  // streaming 主路径的唯一 worker 入口：persistent tree 增量解析 + parser-owned tail 边界 + 裁剪 highlights。
  // 它不复用 handleEdits 的 changed-range 事件流，因为调用方需要的是可等待的版本化结果而不是事件。
  async handleStreamingUpdate(
    bufferId: number,
    version: number,
    source: string,
    cacheEnd: number,
    messageId: string,
  ): Promise<void> {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      // 错误随响应返回而不是静默成功：client 会把它转成 rejection，走 Code 的 plain-text 兼容路径。
      postWorkerMessage({
        type: "STREAMING_UPDATE_RESPONSE",
        bufferId,
        version,
        messageId,
        error: "No parser state found for buffer",
      } satisfies TreeSitterWorkerResponse)
      return
    }

    // parserState.content 保存的是上一次 normalize 后的 parse 文本，diff 必须在同一个 normalize 域里计算。
    const parseContent = this.normalizeStreamingParseContent(parserState.filetype, source)
    const oldContent = parserState.content
    const edit = this.computeCodeUnitEdit(oldContent, parseContent)

    // 增量 parse 复用旧 tree：tree-sitter 只重分析 edit 影响的子树，这是 persistent path 的核心收益。
    parserState.tree.edit(edit)
    const newTree = parserState.parser.parse(parseContent, parserState.tree)
    if (!newTree) {
      // parse 失败不销毁既有 tree：下一次 update 仍可从旧状态增量恢复。
      postWorkerMessage({
        type: "STREAMING_UPDATE_RESPONSE",
        bufferId,
        version,
        messageId,
        error: "Failed to parse buffer",
      } satisfies TreeSitterWorkerResponse)
      return
    }

    const changedRanges = parserState.tree.getChangedRanges(newTree)
    parserState.tree = newTree
    parserState.content = parseContent

    // changedRanges 为空不代表无变化（tree-sitter 的已知怪癖），退化为 edit 起点保证失效证据不丢失。
    const changedStart =
      changedRanges.length > 0 ? Math.min(...changedRanges.map((range) => range.startIndex)) : edit.startIndex

    // tailStart 是唯一的缓存资格来源；changedStart 只是失效证据，不能反过来证明某段可缓存。
    let tailStart = this.lastRenderBlockStart(newTree.rootNode)
    const earliestUnresolved = await this.updateReferenceState(parserState, edit.startIndex)
    if (earliestUnresolved !== undefined) {
      // 引用定义可以晚于用法到达，未解析用法所在的最早 block 必须回退进 tail。
      tailStart = Math.min(tailStart, earliestUnresolved)
    }

    // Code 侧已缓存 cacheEnd 之前的内容；worker 只返回 min(changedStart, tailStart, cacheEnd) 之后的 highlights。
    const clipStart = Math.min(changedStart, tailStart, cacheEnd)
    const matches = this.capturesFrom(parserState.queries.highlights, newTree.rootNode, clipStart)

    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
    if (parserState.queries.injections) {
      // inline/code fence 的 injected parse 只覆盖 tail；前缀 injection 内容未变，重算是纯浪费。
      const injectionResult = await this.processInjections(parserState, clipStart)
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    // highlights 与 one-shot 保持完全相同的 parse 域输出（含 zero-length injection 捕获），
    // 转换层本就容忍 synthetic newline 造成的 +1 末端偏移，裁剪反而会破坏与既有路径的逐位一致。
    const highlights = this.getSimpleHighlights(matches, injectionRanges)

    postWorkerMessage({
      type: "STREAMING_UPDATE_RESPONSE",
      bufferId,
      version,
      messageId,
      // changedStart/tailStart 属于 source 域合同；synthetic newline 只是 parse 补偿，不得泄漏给调用方。
      changedStart: Math.min(changedStart, source.length),
      tailStart,
      highlights,
    } satisfies TreeSitterWorkerResponse)
  }

  async handleResetBuffer(
    bufferId: number,
    version: number,
    content: string,
  ): Promise<{ highlights?: HighlightResponse[]; warning?: string; error?: string }> {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return { warning: "No parser state found for buffer" }
    }

    parserState.content = content

    const newTree = parserState.parser.parse(content)

    if (!newTree) {
      return { error: "Failed to parse buffer during reset" }
    }

    parserState.tree = newTree
    const matches = parserState.queries.highlights.captures(parserState.tree.rootNode)

    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  disposeBuffer(bufferId: number): void {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return
    }

    parserState.tree.delete()
    parserState.parser.delete()

    this.bufferParsers.delete(bufferId)
  }

  async handleOneShotHighlight(content: string, filetype: string, messageId: string): Promise<void> {
    const reusableState = await this.getReusableParser(filetype)

    if (!reusableState) {
      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: false,
        warning: `No parser available for filetype ${filetype}`,
      })
      return
    }

    // Markdown Parser BUG: For markdown, ensure content ends with newline so closing delimiters are parsed correctly
    // The tree-sitter markdown parser only creates closing delimiter nodes when followed by newline
    const parseContent = filetype === "markdown" && content.endsWith("```") ? content + "\n" : content

    const tree = reusableState.parser.parse(parseContent)

    if (!tree) {
      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: false,
        error: "Failed to parse content",
      })
      return
    }

    try {
      const matches = reusableState.filetypeParser.queries.highlights.captures(tree.rootNode)

      let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
      if (reusableState.filetypeParser.queries.injections) {
        const parserState: ParserState = {
          parser: reusableState.parser,
          tree,
          queries: reusableState.filetypeParser.queries,
          filetype,
          content,
          injectionMapping: reusableState.filetypeParser.injectionMapping,
        }
        const injectionResult = await this.processInjections(parserState)

        matches.push(...injectionResult.captures)
        injectionRanges = injectionResult.injectionRanges
      }

      const highlights = this.getSimpleHighlights(matches, injectionRanges)

      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: true,
        highlights,
      })
    } finally {
      tree.delete()
    }
  }

  async updateDataPath(dataPath: string): Promise<void> {
    this.dataPath = dataPath
    this.tsDataPath = path.join(dataPath, "tree-sitter")

    try {
      await mkdir(path.join(this.tsDataPath, "languages"), { recursive: true })
      await mkdir(path.join(this.tsDataPath, "queries"), { recursive: true })
    } catch (error) {
      throw new Error(`Failed to update data path: ${error}`)
    }
  }

  async clearCache(): Promise<void> {
    if (!this.dataPath || !this.tsDataPath) {
      throw new Error("No data path configured")
    }

    const { rm } = await import("fs/promises")

    try {
      const treeSitterPath = path.join(this.dataPath, "tree-sitter")

      await rm(treeSitterPath, { recursive: true, force: true })

      await mkdir(path.join(treeSitterPath, "languages"), { recursive: true })
      await mkdir(path.join(treeSitterPath, "queries"), { recursive: true })

      this.filetypeParsers.clear()
      this.filetypeParserPromises.clear()
      this.reusableParsers.clear()
      this.reusableParserPromises.clear()
    } catch (error) {
      throw new Error(`Failed to clear cache: ${error}`)
    }
  }
}

function logMessage(type: TreeSitterWorkerLogType, ...args: unknown[]): void {
  postWorkerMessage({
    type: "WORKER_LOG",
    logType: type,
    data: args,
  } satisfies TreeSitterWorkerResponse)
}

function postWorkerError(bufferId: number | undefined, error: unknown): void {
  postWorkerMessage({
    type: "ERROR",
    bufferId,
    error: error instanceof Error ? error.stack || error.message : String(error),
  } satisfies TreeSitterWorkerResponse)
}

if (isWorkerRuntime) {
  const worker = new ParserWorker()

  console.log = (...args) => logMessage("log", ...args)
  console.error = (...args) => logMessage("error", ...args)
  console.warn = (...args) => logMessage("warn", ...args)

  setWorkerMessageHandler<TreeSitterWorkerRequest>(async (event: WorkerMessageEvent<TreeSitterWorkerRequest>) => {
    const message = event.data
    const messageType = String((event.data as { type?: unknown }).type ?? "unknown")

    try {
      switch (message.type) {
        case "INIT":
          try {
            await worker.initialize({ dataPath: message.dataPath })
            postWorkerMessage({ type: "INIT_RESPONSE" } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "INIT_RESPONSE",
              error: error instanceof Error ? error.stack || error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        case "ADD_FILETYPE_PARSER":
          worker.addFiletypeParser(message.filetypeParser)
          break

        case "PRELOAD_PARSER": {
          const maybeParser = await worker.preloadParser(message.filetype)
          postWorkerMessage({
            type: "PRELOAD_PARSER_RESPONSE",
            messageId: message.messageId,
            hasParser: !!maybeParser,
          } satisfies TreeSitterWorkerResponse)
          break
        }

        case "INITIALIZE_PARSER":
          await worker.handleInitializeParser(
            message.bufferId,
            message.version,
            message.content,
            message.filetype,
            message.messageId,
          )
          break

        case "HANDLE_EDITS": {
          const response = await worker.handleEdits(message.bufferId, message.content, message.edits)
          if (response.highlights && response.highlights.length > 0) {
            postWorkerMessage({
              type: "HIGHLIGHT_RESPONSE",
              bufferId: message.bufferId,
              version: message.version,
              highlights: response.highlights,
            } satisfies TreeSitterWorkerResponse)
          } else if (response.warning) {
            postWorkerMessage({
              type: "WARNING",
              bufferId: message.bufferId,
              warning: response.warning,
            } satisfies TreeSitterWorkerResponse)
          } else if (response.error) {
            postWorkerMessage({
              type: "ERROR",
              bufferId: message.bufferId,
              error: response.error,
            } satisfies TreeSitterWorkerResponse)
          }
          break
        }

        case "GET_PERFORMANCE":
          postWorkerMessage({
            type: "PERFORMANCE_RESPONSE",
            performance: worker.performance,
            messageId: message.messageId,
          } satisfies TreeSitterWorkerResponse)
          break

        case "RESET_BUFFER": {
          const resetResponse = await worker.handleResetBuffer(message.bufferId, message.version, message.content)
          if (resetResponse.highlights && resetResponse.highlights.length > 0) {
            postWorkerMessage({
              type: "HIGHLIGHT_RESPONSE",
              bufferId: message.bufferId,
              version: message.version,
              highlights: resetResponse.highlights,
            } satisfies TreeSitterWorkerResponse)
          } else if (resetResponse.warning) {
            postWorkerMessage({
              type: "WARNING",
              bufferId: message.bufferId,
              warning: resetResponse.warning,
            } satisfies TreeSitterWorkerResponse)
          } else if (resetResponse.error) {
            postWorkerMessage({
              type: "ERROR",
              bufferId: message.bufferId,
              error: resetResponse.error,
            } satisfies TreeSitterWorkerResponse)
          }
          break
        }

        case "DISPOSE_BUFFER":
          worker.disposeBuffer(message.bufferId)
          postWorkerMessage({
            type: "BUFFER_DISPOSED",
            bufferId: message.bufferId,
          } satisfies TreeSitterWorkerResponse)
          break

        case "ONESHOT_HIGHLIGHT":
          await worker.handleOneShotHighlight(message.content, message.filetype, message.messageId)
          break

        case "STREAMING_UPDATE":
          await worker.handleStreamingUpdate(
            message.bufferId,
            message.version,
            message.content,
            message.cacheEnd,
            message.messageId,
          )
          break

        case "UPDATE_DATA_PATH":
          try {
            await worker.updateDataPath(message.dataPath)
            postWorkerMessage({
              type: "UPDATE_DATA_PATH_RESPONSE",
              messageId: message.messageId,
            } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "UPDATE_DATA_PATH_RESPONSE",
              messageId: message.messageId,
              error: error instanceof Error ? error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        case "CLEAR_CACHE":
          try {
            await worker.clearCache()
            postWorkerMessage({
              type: "CLEAR_CACHE_RESPONSE",
              messageId: message.messageId,
            } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "CLEAR_CACHE_RESPONSE",
              messageId: message.messageId,
              error: error instanceof Error ? error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        default:
          postWorkerMessage({
            type: "ERROR",
            error: `Unknown message type: ${messageType}`,
          } satisfies TreeSitterWorkerResponse)
      }
    } catch (error) {
      if ("bufferId" in message) {
        postWorkerError(message.bufferId, error)
      } else {
        postWorkerError(undefined, error)
      }
    }
  })
}
