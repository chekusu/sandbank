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

        # Create a Boxlite runtime for the custom home_dir, then use SimpleBox
        # with that runtime. SimpleBox's exec is more stable for rapid consecutive
        # calls than Boxlite.create(BoxOptions).exec().
        Options = getattr(boxlite, "Options", None)
        Boxlite = getattr(boxlite, "Boxlite", None)
        if Options and Boxlite:
            try:
                opts = Options(home_dir=self._home)
                self._boxlite_rt = Boxlite(opts)
            except Exception:
                self._boxlite_rt = None
        else:
            self._boxlite_rt = None

        # Use SimpleBox with the runtime (handles home_dir correctly)
        self._runtime = "simple_box"

    async def create(self, params):
        await self._ensure_runtime()

        image = params.get("image", "")
        rootfs = params.get("rootfs_path")
        now = datetime.now(timezone.utc).isoformat()

        # Normalize env/ports
        env = params.get("env")
        if isinstance(env, dict):
            env = list(env.items())
        ports = params.get("ports")
        if isinstance(ports, list):
            ports = [tuple(p) for p in ports]

        if self._runtime == "simple_box":
            # SimpleBox uses: image, memory_mib, cpus, disk_size_gb, env, working_dir
            # rootfs_path overrides image when provided (local OCI layout directory)
            sb_kwargs = {"rootfs_path": rootfs} if rootfs else {"image": image}
            if params.get("cpu") is not None:
                sb_kwargs["cpus"] = params["cpu"]
            if params.get("memory_mb") is not None:
                sb_kwargs["memory_mib"] = params["memory_mb"]
            if params.get("disk_size_gb") is not None:
                sb_kwargs["disk_size_gb"] = params["disk_size_gb"]
            if env is not None:
                sb_kwargs["env"] = env
            if params.get("working_dir") is not None:
                sb_kwargs["working_dir"] = params["working_dir"]
            if ports is not None:
                sb_kwargs["ports"] = ports

            # Disable auto_remove so runtime.get() works after stop (needed for snapshot restore)
            sb_kwargs["auto_remove"] = params.get("auto_remove", False)

            # Pass the Boxlite runtime to SimpleBox so it uses the correct home_dir
            if getattr(self, "_boxlite_rt", None) is not None:
                sb_kwargs["runtime"] = self._boxlite_rt
            sb = boxlite.SimpleBox(**sb_kwargs)
            box = await sb.__aenter__()
            box_id = str(getattr(box, "id", None)
                         or getattr(getattr(box, "_box", None), "id", None)
                         or id(box))
            self._boxes[box_id] = box
            self._simple_boxes[box_id] = sb
        else:
            # Boxlite.create(BoxOptions(...), name=None)
            BoxOptions = getattr(boxlite, "BoxOptions", None)
            if BoxOptions is not None:
                opt_kwargs = {}
                if rootfs:
                    opt_kwargs["rootfs_path"] = rootfs
                else:
                    opt_kwargs["image"] = image
                if params.get("cpu") is not None:
                    opt_kwargs["cpus"] = params["cpu"]
                if params.get("memory_mb") is not None:
                    opt_kwargs["memory_mib"] = params["memory_mb"]
                if params.get("disk_size_gb") is not None:
                    opt_kwargs["disk_size_gb"] = params["disk_size_gb"]
                if env is not None:
                    opt_kwargs["env"] = env
                if params.get("working_dir") is not None:
                    opt_kwargs["working_dir"] = params["working_dir"]
                if ports is not None:
                    opt_kwargs["ports"] = ports
                opts = BoxOptions(**opt_kwargs)
                box = await self._runtime.create(opts)
            else:
                # Legacy fallback: pass as kwargs
                kwargs = {"rootfs_path": rootfs} if rootfs else {"image": image}
                for k in ("cpu", "memory_mb", "disk_size_gb", "working_dir"):
                    if params.get(k) is not None:
                        kwargs[k] = params[k]
                if env is not None:
                    kwargs["env"] = env
                if ports is not None:
                    kwargs["ports"] = ports
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
            "cpu": params.get("cpu", 1),
            "memory_mb": params.get("memory_mb", 512),
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
                result = await box._box.exec(cmd[0], args=cmd[1:])
            except Exception as e:
                errors.append(f"box._box.exec(...): {e}")

        if result is None:
            raise RuntimeError(f"All exec strategies failed: {'; '.join(errors)}")

        stdout = ""
        stderr = ""
        exit_code = 0

        # Execution object (Boxlite runtime API): collect stdout/stderr streams, then wait
        if hasattr(result, "wait") and callable(result.wait):
            async def _collect(stream_fn):
                try:
                    buf = bytearray()
                    async for chunk in stream_fn():
                        if isinstance(chunk, (bytes, bytearray)):
                            buf.extend(chunk)
                        else:
                            buf.extend(str(chunk).encode("utf-8"))
                    return buf.decode("utf-8", errors="replace")
                except Exception:
                    return ""

            # Read stdout/stderr concurrently to avoid pipe deadlocks
            tasks = []
            has_stdout = hasattr(result, "stdout") and callable(result.stdout)
            has_stderr = hasattr(result, "stderr") and callable(result.stderr)
            if has_stdout:
                tasks.append(asyncio.create_task(_collect(result.stdout)))
            if has_stderr:
                tasks.append(asyncio.create_task(_collect(result.stderr)))

            if tasks:
                collected = await asyncio.gather(*tasks)
                idx = 0
                if has_stdout:
                    stdout = collected[idx]; idx += 1
                if has_stderr:
                    stderr = collected[idx]

            exec_result = await result.wait()
            exit_code = int(getattr(exec_result, "exit_code",
                           getattr(exec_result, "returncode", 0)) or 0)
        else:
            # SimpleBox / legacy: result already has stdout/stderr as attributes
            raw_stdout = getattr(result, "stdout", "")
            raw_stderr = getattr(result, "stderr", "")
            if callable(raw_stdout):
                raw_stdout = raw_stdout()
            if callable(raw_stderr):
                raw_stderr = raw_stderr()
            stdout = str(raw_stdout or "")
            stderr = str(raw_stderr or "")
            exit_code = int(getattr(result, "exit_code",
                           getattr(result, "returncode", 0)) or 0)

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
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

    def _get_box(self, box_id):
        box = self._boxes.get(box_id)
        if box is None:
            raise ValueError(f"Box not found: {box_id}")
        # SimpleBox wraps the real Box — unwrap to get snapshot handle
        inner = getattr(box, "_box", box)
        return inner

    async def create_snapshot(self, box_id, name):
        # boxlite snapshot uses fork_qcow2 (rename + COW child). If QEMU is
        # running, its FD still points to the renamed inode, so post-snapshot
        # writes corrupt the snapshot file. Must stop → snapshot → restart.
        inner = self._get_box(box_id)
        await inner.stop()

        rt = getattr(self, "_boxlite_rt", None)
        if rt is None:
            raise RuntimeError("Cannot create snapshot: no Boxlite runtime")
        fresh = await rt.get(box_id)
        if fresh is None:
            raise RuntimeError(f"Cannot get fresh handle for box {box_id}")
        snap_handle = getattr(fresh, "snapshot", None)
        if snap_handle is None:
            raise RuntimeError("Fresh handle has no snapshot support")

        info = await snap_handle.create(name=name)
        snap_name = str(getattr(info, "name", name))

        # Restart the VM with the new COW child disk
        await fresh.__aenter__()
        # Update SimpleBox/Box internal references
        old_sb = self._simple_boxes.get(box_id)
        old_box = self._boxes.get(box_id)
        if old_sb and hasattr(old_sb, "_box"):
            old_sb._box = fresh
            old_sb._started = True
        if old_box and hasattr(old_box, "_box"):
            old_box._box = fresh
        else:
            self._boxes[box_id] = fresh

        return {
            "id": str(getattr(info, "id", snap_name)),
            "box_id": box_id,
            "name": snap_name,
            "created_at": int(getattr(info, "created_at", 0)),
            "size_bytes": int(getattr(info, "size_bytes", 0)),
            "guest_disk_bytes": int(getattr(info, "guest_disk_bytes", 0) or 0),
            "container_disk_bytes": int(getattr(info, "container_disk_bytes", 0) or 0),
        }

    async def restore_snapshot(self, box_id, name):
        # Same stop → fresh handle pattern as create_snapshot.
        # stop() also invalidates the LiteBox handle (cancels shutdown_token).
        inner = self._get_box(box_id)
        await inner.stop()

        rt = getattr(self, "_boxlite_rt", None)
        if rt is None:
            raise RuntimeError("Cannot restore snapshot: no Boxlite runtime")
        fresh = await rt.get(box_id)
        if fresh is None:
            raise RuntimeError(f"Cannot get fresh handle for box {box_id}")
        fresh_snap = getattr(fresh, "snapshot", None)
        if fresh_snap is None:
            raise RuntimeError("Fresh handle has no snapshot support")

        await fresh_snap.restore(name)

        # Restart with the restored disk
        await fresh.__aenter__()
        # Update SimpleBox/Box internal references
        old_sb = self._simple_boxes.get(box_id)
        old_box = self._boxes.get(box_id)
        if old_sb and hasattr(old_sb, "_box"):
            old_sb._box = fresh
            old_sb._started = True
        if old_box and hasattr(old_box, "_box"):
            old_box._box = fresh
        else:
            self._boxes[box_id] = fresh

    async def list_snapshots(self, box_id):
        inner = self._get_box(box_id)
        snap_handle = getattr(inner, "snapshot", None)
        if snap_handle is None:
            raise RuntimeError("Box does not support snapshots")
        snapshots = await snap_handle.list()
        return [{
            "id": str(getattr(s, "id", "")),
            "box_id": box_id,
            "name": str(getattr(s, "name", "")),
            "created_at": int(getattr(s, "created_at", 0)),
            "size_bytes": int(getattr(s, "size_bytes", 0)),
            "guest_disk_bytes": int(getattr(s, "guest_disk_bytes", 0) or 0),
            "container_disk_bytes": int(getattr(s, "container_disk_bytes", 0) or 0),
        } for s in snapshots]

    async def delete_snapshot(self, box_id, name):
        inner = self._get_box(box_id)
        snap_handle = getattr(inner, "snapshot", None)
        if snap_handle is None:
            raise RuntimeError("Box does not support snapshots")
        await snap_handle.remove(name)

    async def clone_box(self, box_id, name=None):
        inner = self._get_box(box_id)
        from boxlite import CloneOptions
        cloned = await inner.clone_box(options=CloneOptions(), name=name)
        cloned_id = cloned.id
        self._boxes[cloned_id] = cloned
        info = cloned.info()
        return {
            "id": cloned_id,
            "name": info.name if hasattr(info, "name") else name,
            "status": str(info.state) if hasattr(info, "state") else "stopped",
            "image": str(info.image) if hasattr(info, "image") else "",
            "cpu": int(info.cpus) if hasattr(info, "cpus") else 0,
            "memory_mb": int(info.memory_mib) if hasattr(info, "memory_mib") else 0,
            "created_at": "",
        }

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
            elif action == "create_snapshot":
                result = await bridge.create_snapshot(cmd["box_id"], cmd["name"])
            elif action == "restore_snapshot":
                await bridge.restore_snapshot(cmd["box_id"], cmd["name"])
                result = {}
            elif action == "list_snapshots":
                result = await bridge.list_snapshots(cmd["box_id"])
            elif action == "delete_snapshot":
                await bridge.delete_snapshot(cmd["box_id"], cmd["name"])
                result = {}
            elif action == "clone":
                result = await bridge.clone_box(cmd["box_id"], cmd.get("name"))
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
      return send<BoxLiteSnapshot>({ action: 'create_snapshot', box_id: boxId, name })
    },

    async restoreSnapshot(boxId: string, name: string): Promise<void> {
      await send({ action: 'restore_snapshot', box_id: boxId, name })
    },

    async listSnapshots(boxId: string): Promise<BoxLiteSnapshot[]> {
      return send<BoxLiteSnapshot[]>({ action: 'list_snapshots', box_id: boxId })
    },

    async deleteSnapshot(boxId: string, name: string): Promise<void> {
      await send({ action: 'delete_snapshot', box_id: boxId, name })
    },

    async cloneBox(boxId: string, name?: string): Promise<BoxLiteBox> {
      return send<BoxLiteBox>({ action: 'clone', box_id: boxId, ...(name ? { name } : {}) })
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
