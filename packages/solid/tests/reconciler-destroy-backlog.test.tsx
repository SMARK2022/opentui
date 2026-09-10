/** @jsxImportSource @opentui/solid */
// 回归测试：reconciler 的 _removeNode 把销毁 defer 到 process.nextTick，
// 在主线程被连续同步渲染占满（不 yield 事件循环）时 nextTick 被饿死，待销毁积压无界增长
// 最终耗尽 native handle 注册表（65535）→ TUI 卡死。
// 本测试锁定修复后的不变量：紧凑移除下待销毁积压必须有界，且 settle 后全部销毁（非真泄漏）。
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import type { Renderable } from "@opentui/core"

// 与 reconciler.ts 的 MAX_PENDING_DESTROY 保持一致：积压超过它时必须同步 drain。
const EXPECTED_MAX_PENDING = 256

test("defer destroy backlog stays bounded when the event loop is starved", async () => {
  const tracked: Renderable[] = []
  const TOTAL = 300
  const [items, setItems] = createSignal<number[]>(Array.from({ length: TOTAL }, (_, i) => i))
  const app = await testRender(
    () => (
      <box>
        <For each={items()}>{(i) => <text ref={(r) => tracked.push(r as Renderable)}>{`item ${i}`}</text>}</For>
      </box>
    ),
    { width: 40, height: 10 },
  )
  await app.renderOnce()
  expect(tracked.length).toBe(TOTAL)

  // 一次性移除全部。Solid 的信号更新会同步冲刷 For 的移除（reconcile 同步调用 _removeNode），
  // 而销毁被 defer 到 nextTick；观测点不夹带任何 await/yield，直接同步读 isDestroyed，
  // 保证无论 renderOnce/await 是否排干 nextTick，都能稳健观测到「移除后尚未销毁」的积压。
  setItems([])
  const undestroyed = tracked.filter((r) => !r.isDestroyed).length
  // 修复前：~TOTAL 全部积压未销毁（nextTick 饿死）；修复后：≤ MAX_PENDING_DESTROY（超阈值已同步 drain）。
  expect(undestroyed).toBeLessThanOrEqual(EXPECTED_MAX_PENDING)

  // settle（让出事件循环）后应全部销毁——证明积压只是被兜底，不是真泄漏。
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 10))
    await app.renderOnce()
  }
  expect(tracked.filter((r) => !r.isDestroyed).length).toBe(0)
  app.renderer.destroy()
})
