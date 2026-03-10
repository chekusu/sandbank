import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BoxLiteBox,
  BoxLiteClient,
  BoxLiteCreateParams,
  BoxLiteExecRequest,
  BoxLiteLocalConfig,
  BoxLiteSnapshot,
} from './types.js'

// ─── Python bridge script (embedded) ──────────────────────────────────────────

const BRIDGE_SCRIPT = `#!/usr/bin/env python3
"""boxlite_bridge.py — JSON-line bridge between TypeScript and boxlite Python SDK.

Protocol:
  → stdin:  one JSON object per line  {id, action, ...params}
  ← stdout: one JSON object per line  {id, result} | {id, error}
  First output line: {ready: true, version: "..."}
"""
import asyncio, json, sys, os, traceback
from datetime import datetime, timezone

try:
    import boxlite
except ImportError:
    sys.stdout.write(json.dumps({
        "ready": False,
        "error": "boxlite Python package not found. Install with: pip install boxlite"
    }) + "\\n")
    sys.stdout.flush()
    sys.exit(1)


class Bridge:
    def __init__(self, home=None):
        self._home = home or os.environ.get("BOXLITE_HOME", os.path.expanduser("~/.boxlite"))
        self._runtime = None
        self._boxes = {}  # box_id -> box object
        self._simple_boxes = {}  # box_id -> SimpleBox (for cleanup)

    async def _ensure_runtime(self):
        if self._runtime is not None:
            return

        # Try BoxliteRuntime (full API)
        for attr in ("BoxliteRuntime", "Runtime", "runtime"):
            cls = getattr(boxlite, attr, None)
            if cls is None:
                continue
            try:
                rt = cls(home=self._home) if callable(cls) else cls
                if asyncio.iscoroutinefunction(getattr(rt, "start", None)):
                    await rt.start()
                self._runtime = rt
                return
            except Exception:
                continue

        # Fallback: no runtime, use SimpleBox per box
        self._runtime = "simple_box"

    async def create(self, params):
        await self._ensure_runtime()

        image = params["image"]
        kwargs = {"image": image}
        for k in ("cpu", "memory_mb", "disk_size_gb", "env", "working_dir", "ports"):
            if params.get(k) is not None:
                if k == "env" and isinstance(params[k], dict):
                    kwargs[k] = list(params[k].items())
                elif k == "ports" and isinstance(params[k], list):
                    kwargs[k] = [tuple(p) for p in params[k]]
                else:
                    kwargs[k] = params[k]

        now = datetime.now(timezone.utc).isoformat()

        if self._runtime == "simple_box":
            sb = boxlite.SimpleBox(**kwargs)
            box = await sb.__aenter__()
            box_id = str(getattr(box, "id", None)
                         or getattr(getattr(box, "_box", None), "id", None)
                         or id(box))
            self._boxes[box_id] = box
            self._simple_boxes[box_id] = sb
        else:
            # Try runtime.create / runtime.create_box
            create_fn = getattr(self._runtime, "create", None) or getattr(self._runtime, "create_box", None)
            if create_fn is None:
                raise RuntimeError("boxlite runtime has no create/create_box method")
            box = await create_fn(**kwargs)
            box_id = str(box.id)
            self._boxes[box_id] = box

        return {
            "id": box_id,
            "status": "running",
            "image": image,
            "cpu": kwargs.get("cpu", 1),
            "memory_mb": kwargs.get("memory_mb", 512),
            "created_at": now,
            "name": None,
        }

    async def get(self, box_id):
        box = self._boxes.get(box_id)
        if box is None:
            raise ValueError(f"Box not found: {box_id}")
        return {
            "id": box_id,
            "status": str(getattr(box, "status", "running")),
            "image": getattr(box, "image", "unknown"),
            "cpu": getattr(box, "cpu", 1),
            "memory_mb": getattr(box, "memory_mb", 512),
            "created_at": str(getattr(box, "created_at", "")),
            "name": getattr(box, "name", None),
        }

    async def list_boxes(self):
        results = []
        for box_id, box in self._boxes.items():
            results.append({
                "id": box_id,
                "status": str(getattr(box, "status", "running")),
                "image": getattr(box, "image", "unknown"),
                "cpu": getattr(box, "cpu", 1),
                "memory_mb": getattr(box, "memory_mb", 512),
                "created_at": str(getattr(box, "created_at", "")),
                "name": getattr(box, "name", None),
            })
        return results

    async def exec_cmd(self, box_id, cmd, **kwargs):
        box = self._boxes.get(box_id)
        if box is None:
            raise ValueError(f"Box not found: {box_id}")

        result = None
        errors = []

        # Strategy 1: box.exec(*cmd)
        try:
            result = await box.exec(*cmd)
        except Exception as e:
            errors.append(f"box.exec(*cmd): {e}")

        # Strategy 2: box.exec(cmd[0], args=cmd[1:])
        if result is None:
            try:
                result = await box.exec(cmd[0], args=cmd[1:])
            except Exception as e:
                errors.append(f"box.exec(cmd[0], args=...): {e}")

        # Strategy 3: box._box.exec(cmd[0], args=cmd[1:])
        if result is None and hasattr(box, "_box"):
            try:
                exec_obj = await box._box.exec(cmd[0], args=cmd[1:])
                if hasattr(exec_obj, "wait"):
                    result = await exec_obj.wait()
                else:
                    result = exec_obj
            except Exception as e:
                errors.append(f"box._box.exec(...): {e}")

        if result is None:
            raise RuntimeError(f"All exec strategies failed: {'; '.join(errors)}")

        return {
            "stdout": str(getattr(result, "stdout", "") or ""),
            "stderr": str(getattr(result, "stderr", "") or ""),
            "exit_code": int(getattr(result, "exit_code",
                           getattr(result, "returncode", 0)) or 0),
        }

    async def destroy(self, box_id):
        box = self._boxes.pop(box_id, None)
        sb = self._simple_boxes.pop(box_id, None)

        if sb is not None:
            try:
                await sb.__aexit__(None, None, None)
            except Exception:
                pass
            return

        if box is not None and self._runtime != "simple_box":
            for method_name in ("destroy", "delete", "remove"):
                fn = getattr(self._runtime, method_name, None)
                if fn is not None:
                    try:
                        await fn(box_id)
                        return
                    except Exception:
                        continue
            if hasattr(box, "destroy"):
                await box.destroy()
            elif hasattr(box, "stop"):
                await box.stop()

    async def stop(self, box_id):
        box = self._boxes.get(box_id)
        if box and hasattr(box, "stop"):
            await box.stop()

    async def start(self, box_id):
        box = self._boxes.get(box_id)
        if box and hasattr(box, "start"):
            await box.start()

    async def cleanup(self):
        for box_id in list(self._boxes.keys()):
            try:
                await self.destroy(box_id)
            except Exception:
                pass


def write_json(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


async def main():
    home = os.environ.get("BOXLITE_BRIDGE_HOME")
    bridge = Bridge(home=home)
    loop = asyncio.get_running_loop()

    write_json({"ready": True, "version": getattr(boxlite, "__version__", "unknown")})

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        req_id = 0
        try:
            cmd = json.loads(line)
            req_id = cmd.get("id", 0)
            action = cmd.get("action", "")

            if action == "create":
                result = await bridge.create(cmd)
            elif action == "get":
                result = await bridge.get(cmd["box_id"])
            elif action == "list":
                result = await bridge.list_boxes()
            elif action == "exec":
                result = await bridge.exec_cmd(cmd["box_id"], cmd["cmd"])
            elif action == "destroy":
                await bridge.destroy(cmd["box_id"])
                result = {}
            elif action == "start":
                await bridge.start(cmd["box_id"])
                result = {}
            elif action == "stop":
                await bridge.stop(cmd["box_id"])
                result = {}
            elif action == "ping":
                result = {"pong": True}
            else:
                raise ValueError(f"Unknown action: {action}")

            write_json({"id": req_id, "result": result})
        except Exception as e:
            write_json({"id": req_id, "error": f"{type(e).__name__}: {e}"})

    await bridge.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
`

// ─── TypeScript local client ──────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeResponse {
  id?: number
  result?: unknown
  error?: string
  ready?: boolean
  version?: string
}

/**
 * Create a BoxLite local client that communicates with the boxlite Python SDK
 * via a JSON-line subprocess bridge.
 */
export function createBoxLiteLocalClient(config: BoxLiteLocalConfig): BoxLiteClient {
  const pythonPath = config.pythonPath ?? 'python3'
  const boxliteHome = config.boxliteHome

  let process: ChildProcess | null = null
  let readline: ReadlineInterface | null = null
  let requestId = 0
  let readyPromise: Promise<void> | null = null
  const pending = new Map<number, PendingRequest>()

  // Write bridge script to a temp file
  let bridgeScriptPath: string | null = null

  function getBridgeScriptPath(): string {
    if (bridgeScriptPath) return bridgeScriptPath
    bridgeScriptPath = join(tmpdir(), `boxlite-bridge-${process?.pid ?? Date.now()}.py`)
    writeFileSync(bridgeScriptPath, BRIDGE_SCRIPT, 'utf-8')
    return bridgeScriptPath
  }

  function ensureBridge(): Promise<void> {
    if (readyPromise) return readyPromise

    readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const scriptPath = getBridgeScriptPath()

      const env: Record<string, string> = { ...globalThis.process.env as Record<string, string> }
      if (boxliteHome) {
        env['BOXLITE_BRIDGE_HOME'] = boxliteHome
      }

      process = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      // Collect stderr for error reporting
      let stderrBuf = ''
      process.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      process.on('error', (err) => {
        rejectReady(new Error(`Failed to start boxlite bridge: ${err.message}`))
        cleanup()
      })

      process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          const msg = stderrBuf || `Bridge exited with code ${code}`
          rejectReady(new Error(`BoxLite bridge error: ${msg}`))
          // Reject all pending requests
          for (const [id, req] of pending) {
            req.reject(new Error(`BoxLite bridge exited unexpectedly: ${msg}`))
            clearTimeout(req.timer)
            pending.delete(id)
          }
        }
        cleanup()
      })

      readline = createInterface({ input: process.stdout! })

      let gotReady = false
      readline.on('line', (line: string) => {
        let msg: BridgeResponse
        try {
          msg = JSON.parse(line) as BridgeResponse
        } catch {
          return // Ignore non-JSON output
        }

        // Handle ready signal
        if (!gotReady && 'ready' in msg) {
          gotReady = true
          if (msg.ready) {
            resolveReady()
          } else {
            rejectReady(new Error(`BoxLite bridge init failed: ${msg.error ?? 'unknown error'}`))
          }
          return
        }

        // Handle response to a request
        const id = msg.id
        if (id === undefined) return
        const req = pending.get(id)
        if (!req) return
        pending.delete(id)
        clearTimeout(req.timer)

        if (msg.error) {
          req.reject(new Error(`BoxLite local: ${msg.error}`))
        } else {
          req.resolve(msg.result)
        }
      })
    })

    return readyPromise
  }

  function cleanup() {
    if (bridgeScriptPath) {
      try { unlinkSync(bridgeScriptPath) } catch { /* ignore */ }
      bridgeScriptPath = null
    }
    readline?.close()
    readline = null
    process = null
    readyPromise = null
  }

  async function send<T>(command: Record<string, unknown>, timeoutMs = 300_000): Promise<T> {
    await ensureBridge()

    if (!process?.stdin?.writable) {
      throw new Error('BoxLite bridge is not running')
    }

    const id = ++requestId

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`BoxLite bridge request timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      process!.stdin!.write(JSON.stringify({ id, ...command }) + '\n')
    })
  }

  // ─── BoxLiteClient implementation ───

  return {
    async createBox(params: BoxLiteCreateParams): Promise<BoxLiteBox> {
      return send<BoxLiteBox>({ action: 'create', ...params })
    },

    async getBox(boxId: string): Promise<BoxLiteBox> {
      return send<BoxLiteBox>({ action: 'get', box_id: boxId })
    },

    async listBoxes(): Promise<BoxLiteBox[]> {
      return send<BoxLiteBox[]>({ action: 'list' })
    },

    async deleteBox(boxId: string): Promise<void> {
      await send({ action: 'destroy', box_id: boxId })
    },

    async startBox(boxId: string): Promise<void> {
      await send({ action: 'start', box_id: boxId })
    },

    async stopBox(boxId: string): Promise<void> {
      await send({ action: 'stop', box_id: boxId })
    },

    async exec(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const timeoutMs = (req.timeout_seconds ?? 300) * 1000
      const result = await send<{ stdout: string; stderr: string; exit_code: number }>(
        {
          action: 'exec',
          box_id: boxId,
          cmd: req.cmd,
          ...(req.working_dir ? { working_dir: req.working_dir } : {}),
          ...(req.timeout_seconds ? { timeout_seconds: req.timeout_seconds } : {}),
        },
        timeoutMs,
      )
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exit_code ?? 0,
      }
    },

    async execStream(
      boxId: string,
      req: BoxLiteExecRequest,
    ): Promise<ReadableStream<Uint8Array>> {
      const result = await this.exec(boxId, req)
      const encoder = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (result.stdout) controller.enqueue(encoder.encode(result.stdout))
          if (result.stderr) controller.enqueue(encoder.encode(result.stderr))
          controller.close()
        },
      })
    },

    async uploadFiles(boxId: string, path: string, tarData: Uint8Array): Promise<void> {
      // Pipe tar data through exec: base64 decode → tar extract
      const b64 = Buffer.from(tarData).toString('base64')
      // Split into chunks to avoid shell argument limit
      const chunkSize = 50_000
      const chunks: string[] = []
      for (let i = 0; i < b64.length; i += chunkSize) {
        chunks.push(b64.slice(i, i + chunkSize))
      }

      if (chunks.length === 1) {
        await this.exec(boxId, {
          cmd: ['bash', '-c', `echo '${chunks[0]}' | base64 -d | tar xf - -C '${path}'`],
        })
      } else {
        // Write base64 to a temp file in chunks, then decode
        const tmpFile = `/tmp/.boxlite-upload-${Date.now()}`
        for (const chunk of chunks) {
          await this.exec(boxId, {
            cmd: ['bash', '-c', `printf '%s' '${chunk}' >> ${tmpFile}`],
          })
        }
        await this.exec(boxId, {
          cmd: ['bash', '-c', `base64 -d ${tmpFile} | tar xf - -C '${path}' && rm -f ${tmpFile}`],
        })
      }
    },

    async downloadFiles(boxId: string, path: string): Promise<ReadableStream<Uint8Array>> {
      const result = await this.exec(boxId, {
        cmd: ['bash', '-c', `tar cf - -C '${path}' . 2>/dev/null | base64`],
      })
      const data = Buffer.from(result.stdout.trim(), 'base64')
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(data))
          controller.close()
        },
      })
    },

    async createSnapshot(boxId: string, name: string): Promise<BoxLiteSnapshot> {
      throw new Error('Snapshots are not yet supported in local mode')
    },

    async restoreSnapshot(boxId: string, name: string): Promise<void> {
      throw new Error('Snapshots are not yet supported in local mode')
    },

    async listSnapshots(boxId: string): Promise<BoxLiteSnapshot[]> {
      throw new Error('Snapshots are not yet supported in local mode')
    },

    async deleteSnapshot(boxId: string, name: string): Promise<void> {
      throw new Error('Snapshots are not yet supported in local mode')
    },

    async dispose(): Promise<void> {
      if (process?.stdin?.writable) {
        process.stdin.end()
      }
      // Give the bridge a moment to cleanup
      await new Promise<void>(resolve => {
        if (!process) { resolve(); return }
        const timeout = setTimeout(() => {
          process?.kill()
          resolve()
        }, 3000)
        process.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      cleanup()
    },
  }
}
