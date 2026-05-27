import { createDbNativeAgentHarnessHandler, type DbNativeAgentHarnessEnv } from './harness-api.js'

export default {
  fetch(request: Request, env: DbNativeAgentHarnessEnv): Promise<Response> {
    return createDbNativeAgentHarnessHandler(env).fetch(request)
  },
}
