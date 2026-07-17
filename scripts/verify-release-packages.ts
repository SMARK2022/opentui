import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const packageNames = [
  "@opentui/core",
  "@opentui/solid",
  "@opentui/keymap",
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
] as const

const directory = await realpath(requireArgument("--directory"))
const version = requireArgument("--version")
const filenames = new Map(packageNames.map((name) => [name, `${name.slice(1).replace("/", "-")}-${version}.tgz`]))
const expectedFiles = new Set([...filenames.values()])

await verifyChecksums()

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const filename = decodeURIComponent(new URL(request.url).pathname.slice(1))
    // release verifier只暴露已枚举的asset，避免测试server把任意本地路径变成成功响应。
    // 404会让Bun install保留真实下载失败，不能被空包或另一来源掩盖。
    if (!expectedFiles.has(filename)) return new Response("Not found", { status: 404 })
    return new Response(Bun.file(path.join(directory, filename)))
  },
})
const temp = await mkdtemp(path.join(os.tmpdir(), "opentui-release-"))

try {
  const consumer = path.join(temp, "packages", "consumer")
  await mkdir(consumer, { recursive: true })
  const urlFor = (name: (typeof packageNames)[number]) => `http://${server.hostname}:${server.port}/${filenames.get(name)}`

  await Bun.write(
    path.join(temp, "package.json"),
    `${JSON.stringify(
      {
        name: "opentui-release-verifier",
        private: true,
        workspaces: {
          packages: ["packages/*"],
          catalog: {
            "@opentui/core": version,
            "@opentui/solid": version,
            "@opentui/keymap": version,
          },
        },
        overrides: Object.fromEntries(packageNames.map((name) => [name, urlFor(name)])),
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(
    path.join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "consumer",
        private: true,
        type: "module",
        dependencies: {
          "@opentui/core": "catalog:",
          "@opentui/solid": "catalog:",
          "@opentui/keymap": "catalog:",
          "solid-js": "1.9.12",
        },
      },
      null,
      2,
    )}\n`,
  )

  // 先按真实HTTP URL安装，再重复OpenCode build.ts的target reinstall调用。
  // catalog只表达版本合同，11个overrides才是唯一package source；两层缺一都不代表生产路径。
  await run(["bun", "install", "--linker=hoisted"], temp)
  await run(
    // root install已经验证catalog；嵌套consumer在Windows上无法向父workspace解析catalog，target reinstall改用同一语义版本并继续由overrides寻址11-pack。
    ["bun", "install", `--os=${process.platform}`, `--cpu=${process.arch}`, `@opentui/core@${version}`],
    consumer,
  )

  // 先观察用户可见的42/35 frame；official 0.4.3必须在这里以2/3 red，而不是被metadata失败替代。
  // literal输入和期望计数独立于native wrap算法，package能安装但未承载#845时仍会被拒绝。
  await run(
    [
      "bun",
      "-e",
      `import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
const input = "检查log，请你自行独立完整完成相应的调研与检查，并进行多轮的负载并发、高压";
const count = (value, needle) => value.split(needle).length - 1;
const setup = await createTestRenderer({ width: 42, height: 6, footerHeight: 0, useThread: false, consoleMode: "disabled" });
try {
  const sidebar = new BoxRenderable(setup.renderer, { width: 42, height: 6, paddingLeft: 2, paddingRight: 2 });
  const content = new BoxRenderable(setup.renderer, { flexShrink: 0, gap: 1, paddingRight: 1 });
  const goal = new BoxRenderable(setup.renderer, { paddingLeft: 2 });
  goal.add(new TextRenderable(setup.renderer, { content: input, wrapMode: "word" }));
  content.add(goal);
  sidebar.add(content);
  setup.renderer.root.add(sidebar);
  for (let index = 0; index < 3; index++) await setup.renderOnce();
  const frame = setup.captureCharFrame();
  const result = { sourceCount: count(input, "查"), renderedCount: count(frame, "查"), rows: frame.split("\\n").slice(0, 3).map((row) => row.trimEnd()) };
  console.log(JSON.stringify(result));
  if (result.sourceCount !== 2 || result.renderedCount !== 2) throw new Error("release package duplicates a CJK glyph at the Goal wrap boundary");
} finally {
  setup.renderer.destroy();
}`,
    ],
    consumer,
  )

  const coreRoot = await realpath(path.join(consumer, "node_modules", "@opentui", "core"))
  for (const name of packageNames) {
    const direct = path.join(consumer, "node_modules", ...name.split("/"), "package.json")
    // direct framework依赖位于consumer；8个optional native则属于core package的隔离依赖图。
    // 从core realpath读取nested manifests可兼容Bun isolated linker，不依赖glob是否跟随symlink。
    const nested = path.join(path.dirname(coreRoot), name.split("/")[1], "package.json")
    const manifest = await readManifest((await Bun.file(direct).exists()) ? direct : nested)
    if (manifest.version !== version) throw new Error(`${name} version ${manifest.version} does not match ${version}`)
    // 11个tarballs必须声明SMARK fork，避免修复binary继续伪装成upstream package provenance。
    // native manifests由core build复制repository字段，因此这里也验证8个generated packages。
    if (manifest.repository !== "https://github.com/SMARK2022/opentui") {
      throw new Error(`${name} repository points to ${manifest.repository}`)
    }
  }

  console.log(JSON.stringify({ version, packages: packageNames.length, platform: process.platform, arch: process.arch }))
} finally {
  // server和temp目录属于同一个verification transaction；cleanup失败必须让CI失败而不是留下隐性状态。
  // force stop只关闭本脚本owner的listener，不接触用户进程或共享network资源。
  server.stop(true)
  await rm(temp, { recursive: true, force: true })
}

function requireArgument(name: string) {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || !value) throw new Error(`Missing required argument: ${name}`)
  return value
}

async function verifyChecksums() {
  const checksumPath = path.join(directory, "SHA256SUMS")
  const checksums = new Map<string, string>()
  for (const line of (await Bun.file(checksumPath).text()).trim().split("\n")) {
    const row = line.match(/^([a-f0-9]{64})  (.+\.tgz)$/)
    if (!row) throw new Error("SHA256SUMS contains an invalid row")
    checksums.set(row[2], row[1])
  }
  if (checksums.size !== expectedFiles.size) throw new Error(`Expected ${expectedFiles.size} checksums, found ${checksums.size}`)

  for (const filename of expectedFiles) {
    const expected = checksums.get(filename)
    if (!expected) throw new Error(`Checksum missing for ${filename}`)
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(directory, filename)).arrayBuffer()).digest("hex")
    if (actual !== expected) throw new Error(`Checksum mismatch for ${filename}`)
  }
}

async function readManifest(file: string) {
  const value: unknown = await Bun.file(file).json()
  if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") {
    throw new Error(`Invalid package name in ${file}`)
  }
  if (!("version" in value) || typeof value.version !== "string") throw new Error(`Invalid package version in ${file}`)
  if (!("repository" in value) || !value.repository || typeof value.repository !== "object") {
    throw new Error(`Invalid package repository in ${file}`)
  }
  if (!("url" in value.repository) || typeof value.repository.url !== "string") {
    throw new Error(`Invalid package repository URL in ${file}`)
  }
  return { name: value.name, version: value.version, repository: value.repository.url }
}

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" })
  const exit = await process.exited
  if (exit !== 0) throw new Error(`${command.join(" ")} exited ${exit}`)
}
