import { isWorkerRuntime, postWorkerMessage, setWorkerMessageHandler } from "../../platform/worker.js"
import type { TreeSitterWorkerRequest, TreeSitterWorkerResponse } from "./types.js"

const bootId = crypto.randomUUID()

if (isWorkerRuntime) {
  setWorkerMessageHandler<TreeSitterWorkerRequest>(async (event) => {
    const message = event.data

    switch (message.type) {
      case "INIT":
        postWorkerMessage({ type: "INIT_RESPONSE" } satisfies TreeSitterWorkerResponse)
        return
      case "ONESHOT_HIGHLIGHT":
        if (message.content === "hang") {
          await new Promise<void>(() => {})
        }
        postWorkerMessage({
          type: "ONESHOT_HIGHLIGHT_RESPONSE",
          messageId: message.messageId,
          hasParser: true,
          highlights: [],
          warning: bootId,
        } satisfies TreeSitterWorkerResponse)
        return
      case "PRELOAD_PARSER":
        postWorkerMessage({
          type: "PRELOAD_PARSER_RESPONSE",
          messageId: message.messageId,
          hasParser: true,
        } satisfies TreeSitterWorkerResponse)
        return
      case "GET_PERFORMANCE":
        postWorkerMessage({
          type: "PERFORMANCE_RESPONSE",
          messageId: message.messageId,
          performance: {
            averageParseTime: 0,
            parseTimes: [],
            averageQueryTime: 0,
            queryTimes: [],
          },
        } satisfies TreeSitterWorkerResponse)
        return
      case "UPDATE_DATA_PATH":
        postWorkerMessage({ type: "UPDATE_DATA_PATH_RESPONSE", messageId: message.messageId } satisfies TreeSitterWorkerResponse)
        return
      case "CLEAR_CACHE":
        postWorkerMessage({ type: "CLEAR_CACHE_RESPONSE", messageId: message.messageId } satisfies TreeSitterWorkerResponse)
        return
      default:
        return
    }
  })
}
