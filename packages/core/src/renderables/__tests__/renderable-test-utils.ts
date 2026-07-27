import { TextareaRenderable } from "../Textarea.js"
import { type TestRenderer } from "../../testing/test-renderer.js"
import { type TextareaOptions } from "../Textarea.js"
import type { DiffRenderable } from "../Diff.js"
import type { CodeRenderable } from "../Code.js"
import type { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client.js"
import type { ManualClock } from "../../testing/manual-clock.js"

export async function createTextareaRenderable(
  renderer: TestRenderer,
  renderOnce: () => Promise<void>,
  options: TextareaOptions,
): Promise<{ textarea: TextareaRenderable; root: any }> {
  const textareaRenderable = new TextareaRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(textareaRenderable)
  await renderOnce()

  return { textarea: textareaRenderable, root: renderer.root }
}

// Settle Diff highlighting deterministically. Each iteration:
// 1. Render twice — the first render may trigger Diff.requestRebuild via microtask
//    (runs during renderOnce's internal awaits), which calls requestRender while
//    rendering=true, setting immediateRerenderRequested. The resulting re-render
//    is scheduled via clock.setTimeout (ManualClock), so needs a second renderOnce.
// 2. Resolve all pending highlights (proper signal via mock)
// 3. If completion queues a newer request, drain it in the next iteration.
// 4. Await Code.highlightingDone only after that wave creates no newer request.
// Loop exits when mock has no more pending requests (state-based, not count-based).
export async function settleDiffHighlighting(
  diff: DiffRenderable,
  client: MockTreeSitterClient,
  render: () => Promise<void>,
) {
  const MAX = 15
  for (let i = 0; i < MAX; i++) {
    await render()
    await render()
    await Promise.resolve()
    await Promise.resolve()
    if (!client.isHighlighting()) break
    client.resolveAllHighlightOnce()
    await Promise.resolve()
    await Promise.resolve()
    // 最新请求必须先进入下一轮drain，不能在没有resolver的情况下等待其Promise。
    if (client.isHighlighting()) continue

    const left: CodeRenderable | null = (diff as any).leftCodeRenderable
    const right: CodeRenderable | null = (diff as any).rightCodeRenderable
    if (left) await left.highlightingDone
    if (right) await right.highlightingDone
  }
}

// Simulate the passage of time by advancing a ManualClock and rendering frames.
// Useful for testing animations, scroll momentum, and other time-dependent behavior.
export async function simulateFrames(
  clock: ManualClock,
  renderOnce: () => Promise<void>,
  ms: number,
  frameInterval: number = 50,
): Promise<void> {
  const frames = Math.ceil(ms / frameInterval)
  for (let i = 0; i < frames; i++) {
    clock.advance(frameInterval)
    await renderOnce()
  }
}
