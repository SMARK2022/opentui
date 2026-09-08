import { test, expect, beforeEach, afterEach } from "bun:test"
import { Renderable } from "../Renderable.js"
import { DiffRenderable } from "./Diff.js"
import { CodeRenderable } from "./Code.js"
import { SyntaxStyle } from "../syntax-style.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { ManualClock } from "../testing/manual-clock.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import { BoxRenderable } from "./Box.js"
import { settleDiffHighlighting } from "./__tests__/renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let mockClient: MockTreeSitterClient
let clock: ManualClock

beforeEach(async () => {
  mockClient = new MockTreeSitterClient()
  clock = new ManualClock()

  const testRenderer = await createTestRenderer({
    width: 32,
    height: 10,
    gatherStats: true,
    clock,
  })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
  if (mockClient) {
    mockClient.resolveAllHighlightOnce()
    await mockClient.destroy()
  }
})

// When highlights conceal formatting characters (like **), line lengths change,
// potentially triggering wrapping changes, height changes, and onResize.
// This test ensures onResize doesn't cause content resets that create endless loops.
test("DiffRenderable - no endless loop when concealing markdown formatting", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-Some text **boldtext**
-Short
+Some text **boldtext**
+More text **formats**`

  const mockHighlights: SimpleHighlight[] = [
    [10, 11, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [11, 12, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [20, 21, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [21, 22, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [33, 34, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [34, 35, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [42, 43, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [43, 44, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const box = new BoxRenderable(currentRenderer, {
    id: "background-box",
    border: true,
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  box.add(diffRenderable)
  currentRenderer.root.add(box)

  await renderOnce()
  diffRenderable.view = "split"

  await renderOnce()
  diffRenderable.wrapMode = "word"

  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const stats = currentRenderer.getStats()
  expect(stats.frameCount).toBeLessThan(25)
})

// Tests that line numbers align correctly and gutter heights are properly sized
// when switching between view modes and wrap modes in split view
test("DiffRenderable - line number alignment and gutter heights in split view with wrapping", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-Some text **boldtext**
-Short
+Some text **boldtext**
+More text **formats**`

  const mockHighlights: SimpleHighlight[] = [
    [10, 11, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [11, 12, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [20, 21, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [21, 22, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [33, 34, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [34, 35, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [42, 43, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [43, 44, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const box = new BoxRenderable(currentRenderer, {
    id: "background-box",
    border: true,
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  box.add(diffRenderable)
  currentRenderer.root.add(box)

  await renderOnce()
  const unifiedFrame = captureFrame()

  expect(unifiedFrame).toContain("1 - Some text")
  expect(unifiedFrame).toContain("2 - Short")
  expect(unifiedFrame).toContain("1 + Some text")
  expect(unifiedFrame).toContain("2 + More text")

  diffRenderable.view = "split"
  await renderOnce()
  const splitFrame = captureFrame()

  expect(splitFrame).toContain("1 - Some text")
  expect(splitFrame).toContain("1 + Some text")
  expect(splitFrame).toContain("2 - Short")
  expect(splitFrame).toContain("2 + More text")

  // First wrapMode toggle: none → word
  diffRenderable.wrapMode = "word"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)
  const splitWrapFrame = captureFrame()

  const diffChildren = diffRenderable.getChildren()
  const lines = splitWrapFrame.split("\n")

  let leftLine2Row = -1
  let rightLine2Row = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("2 - Short")) {
      leftLine2Row = i
    }
    if (line.includes("2 + More")) {
      rightLine2Row = i
    }
  }

  expect(leftLine2Row).toBeGreaterThan(-1)
  expect(rightLine2Row).toBeGreaterThan(-1)
  expect(leftLine2Row).toBe(rightLine2Row)
  const leftSide = diffChildren[0]
  const rightSide = diffChildren[1]
  const leftGutter = leftSide.getChildren()[0]
  const rightGutter = rightSide.getChildren()[0]
  const leftCode = leftSide.getChildren()[1]
  const rightCode = rightSide.getChildren()[1]

  const leftVisualLines = (leftCode as any).lineInfo?.lineSources?.length || 0
  const rightVisualLines = (rightCode as any).lineInfo?.lineSources?.length || 0

  expect(leftVisualLines).toBe(rightVisualLines)
  expect(leftGutter.height).toBe(leftVisualLines)
  expect(rightGutter.height).toBe(rightVisualLines)

  // Second wrapMode toggle: word → none → word
  diffRenderable.wrapMode = "none"
  await renderOnce()
  diffRenderable.wrapMode = "word"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)
  const splitWrapFrame2 = captureFrame()
  const lines2 = splitWrapFrame2.split("\n")
  let leftLine2Row2 = -1
  let rightLine2Row2 = -1

  for (let i = 0; i < lines2.length; i++) {
    const line = lines2[i]
    if (line.includes("2 - Short")) {
      leftLine2Row2 = i
    }
    if (line.includes("2 + More")) {
      rightLine2Row2 = i
    }
  }

  expect(leftLine2Row2).toBeGreaterThan(-1)
  expect(rightLine2Row2).toBeGreaterThan(-1)
  expect(leftLine2Row2).toBe(rightLine2Row2)

  expect(splitWrapFrame2).toContain("1 - Some text")
  expect(splitWrapFrame2).toContain("boldtext")
  expect(splitWrapFrame2).toContain("2 - Short")
  expect(splitWrapFrame2).toContain("2 + More text")
  expect(splitWrapFrame2).toContain("formats")
})

test("DiffRenderable - hunk row offsets account for concealed markdown lines", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 \`\`\`ts
-const old = 1
+const new = 1
 \`\`\`
@@ -10,2 +10,2 @@
-second old
+second new
 tail`

  const content = "```ts\nconst old = 1\nconst new = 1\n```\nsecond old\nsecond new\ntail"
  const mockHighlights: SimpleHighlight[] = [
    [0, 5, "markup.raw.block", { conceal: "", concealLines: "" }],
    [content.indexOf("```", 5), content.indexOf("```", 5) + 3, "markup.raw.block", { conceal: "", concealLines: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 2])

  const splitContent = "```ts\nconst old = 1\n```\nsecond old\ntail"
  mockClient.setMockResult({
    highlights: [
      [0, 5, "markup.raw.block", { conceal: "", concealLines: "" }],
      [
        splitContent.indexOf("```", 5),
        splitContent.indexOf("```", 5) + 3,
        "markup.raw.block",
        {
          conceal: "",
          concealLines: "",
        },
      ],
    ],
  })
  diffRenderable.view = "split"
  diffRenderable.wrapMode = "none"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})

test("DiffRenderable - hunk row offsets map concealed hunk starts to the next visible line", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const fenceHighlights = (content: string): SimpleHighlight[] => {
    const highlights: SimpleHighlight[] = []
    let start = content.indexOf("```")

    while (start !== -1) {
      const end = content.startsWith("```ts", start) ? start + 5 : start + 3
      highlights.push([start, end, "markup.raw.block", { conceal: "", concealLines: "" }])
      start = content.indexOf("```", end)
    }

    return highlights
  }

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 \`\`\`ts
-first old
+first new
 \`\`\`
@@ -10,3 +10,3 @@
 \`\`\`ts
-second old
+second new
 \`\`\``

  const content = "```ts\nfirst old\nfirst new\n```\n```ts\nsecond old\nsecond new\n```"
  mockClient.setMockResult({ highlights: fenceHighlights(content) })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 2])

  const splitContent = "```ts\nfirst old\n```\n```ts\nsecond old\n```"
  mockClient.setMockResult({ highlights: fenceHighlights(splitContent) })

  diffRenderable.view = "split"
  diffRenderable.wrapMode = "none"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})

test("DiffRenderable - destroys detached sides with the parent", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  await renderOnce()
  // 全量套件中其他文件的异步销毁可能在本用例 await 期间落账，绝对计数会漂移；
  // 以创建前 registry key 集合为基准，断言本用例新增的 key 全部消失，与跨文件漂移无关。
  const beforeKeys = new Set(Renderable.renderablesByNumber.keys())
  try {
    const diffRenderable = new DiffRenderable(currentRenderer, {
      id: "test-diff-lifecycle",
      diff: `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const value = 1
+const value = 2`,
      syntaxStyle,
      filetype: "typescript",
      treeSitterClient: mockClient,
    })

    currentRenderer.root.add(diffRenderable)
    await renderOnce()
    diffRenderable.view = "split"
    await renderOnce()
    // 缓存复用身份必须跨视图转换保持，说明父级退休回收的是固定缓存而不是每次重建。
    const splitChildren = diffRenderable.getChildren()
    expect(splitChildren.length).toBe(2)
    diffRenderable.view = "unified"
    await renderOnce()
    diffRenderable.view = "split"
    await renderOnce()
    expect(diffRenderable.getChildren()).toEqual(splitChildren)
    diffRenderable.view = "unified"
    await renderOnce()

    // 转换后旧 side 不再属于当前 children，但仍是 Diff 创建的 owner，父级销毁必须一并回收。
    diffRenderable.destroyRecursively()

    expect(splitChildren.every((cached) => cached.isDestroyed)).toBe(true)
    // 本用例创建的全部 renderable（含无 id 前缀的 gutter 等内部 owner）都必须离开 registry。
    const leaked = [...Renderable.renderablesByNumber.keys()].filter((key) => !beforeKeys.has(key))
    expect(leaked).toEqual([])
    // 外部 Theme 样式只被借用，父级退休不得销毁调用方的样式。
    expect(() => syntaxStyle.getRegisteredNames()).not.toThrow()
  } finally {
    syntaxStyle.destroy()
  }
})

test("DiffRenderable - retires cached owners and default styles through destroy", async () => {
  await renderOnce()
  const beforeKeys = new Set(Renderable.renderablesByNumber.keys())
  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff-destroy-entry",
    diff: `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const value = 1
+const value = 2`,
    filetype: "typescript",
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()
  diffRenderable.view = "split"
  await renderOnce()
  const splitChildren = diffRenderable.getChildren()
  // split 视图恰好挂载 left/right 两个 side；只该用例不传外部样式，默认样式才归 Diff 所有。
  expect(splitChildren.length).toBe(2)
  const defaultStyles = splitChildren.map((side) => {
    // 经公开 children 遍历拿到 Code.syntaxStyle 是捕获默认样式身份的唯一公开 seam。
    const code = side.getChildren().find((child): child is CodeRenderable => child instanceof CodeRenderable)
    expect(code).toBeDefined()
    return code!.syntaxStyle
  })
  diffRenderable.view = "unified"
  await renderOnce()

  // destroy 与 destroyRecursively 都经 Renderable.destroy 汇聚到 destroySelf，两个入口的退休语义必须一致。
  diffRenderable.destroy()

  expect(splitChildren.every((cached) => cached.isDestroyed)).toBe(true)
  const leaked = [...Renderable.renderablesByNumber.keys()].filter((key) => !beforeKeys.has(key))
  expect(leaked).toEqual([])
  // Diff 自己创建的默认样式随父级退休失效；getRegisteredNames 的 guard 是销毁后的公开探针。
  for (const style of defaultStyles) {
    expect(() => style.getRegisteredNames()).toThrow()
  }
})

test("DiffRenderable - destroys cached error owners across diff transitions", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  await renderOnce()
  const beforeKeys = new Set(Renderable.renderablesByNumber.keys())
  const invalidDiff = `--- a/test.ts
+++ b/test.ts
@@ -a,b +c,d @@
 const value = 1
-const oldValue = 1
+const newValue = 2
 const tail = true`
  const validDiff = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const value = 1
+const value = 2`

  try {
    const diffRenderable = new DiffRenderable(currentRenderer, {
      id: "test-diff-error-lifecycle",
      diff: invalidDiff,
      syntaxStyle,
      filetype: "typescript",
      treeSitterClient: mockClient,
    })

    currentRenderer.root.add(diffRenderable)
    await renderOnce()
    expect(captureFrame()).toContain("Error parsing diff")

    diffRenderable.diff = validDiff
    await renderOnce()
    expect(captureFrame()).toContain("const value = 2")

    diffRenderable.destroyRecursively()

    const leaked = [...Renderable.renderablesByNumber.keys()].filter((key) => !beforeKeys.has(key))
    expect(leaked).toEqual([])
  } finally {
    syntaxStyle.destroy()
  }
})

test("DiffRenderable - hunk row offsets account for multiline concealed ranges", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diff = `--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,1 +10,1 @@
 d`

  mockClient.setMockResult({
    highlights: [[0, 3, "conceal", { conceal: "", concealLines: "" }]],
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff,
    syntaxStyle,
    filetype: "text",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})
