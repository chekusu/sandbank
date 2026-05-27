import { createDbNativeAgentHarnessHandler, type DbNativeAgentHarnessEnv } from './harness-api.js'
import {
  DynamicWorkerExecutionCapsule,
  type DynamicWorkerLoader,
} from '@sandbank.dev/cloudflare/dynamic-worker-capsule'

export interface DbNativeAgentHarnessWorkerEnv extends DbNativeAgentHarnessEnv {
  LOADER?: DynamicWorkerLoader
  SANDBANK_DYNAMIC_WORKER_LOADER?: DynamicWorkerLoader
}

export default {
  fetch(request: Request, env: DbNativeAgentHarnessWorkerEnv): Promise<Response> {
    const loader = env.SANDBANK_DYNAMIC_WORKER_LOADER ?? env.LOADER
    return createDbNativeAgentHarnessHandler(env, loader
      ? {
        createExecutionCapsule: () => new DynamicWorkerExecutionCapsule({
          loader,
          bindingAllowlist: ['SANDBANK_WORKSPACE', 'SANDBANK_RUNTIME'],
        }),
      }
      : {}).fetch(request)
  },
}
