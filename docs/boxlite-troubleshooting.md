# BoxLite / BoxRun 故障排查指南

BoxLite 是一个嵌入式微虚拟机运行时，使用 libkrun（基于 KVM/Hypervisor.framework）在硬件隔离的 VM 中运行 OCI 容器。BoxRun 是其 CLI 管理层，提供 REST API。

## 平台支持

| 平台 | 状态 | 虚拟化后端 |
|------|------|-----------|
| macOS Apple Silicon (arm64) | ✅ 支持 | Hypervisor.framework |
| macOS Intel (x86_64) | ❌ 不支持 | — |
| Linux x86_64 | ✅ 支持 | KVM |
| Linux arm64 | ✅ 支持 | KVM |
| Windows (WSL2) | ✅ 支持 | KVM (嵌套虚拟化) |

## 安装

### BoxLite Python 库

```bash
# 需要 Python 3.10+
python3 -m venv .venv
source .venv/bin/activate
pip install boxlite  # v0.6.0+
```

验证安装：

```python
import asyncio, boxlite

async def main():
    async with boxlite.SimpleBox(image="ubuntu:24.04") as box:
        r = await box.exec("echo", "Hello from BoxLite!")
        print(r.stdout)

asyncio.run(main())
```

### BoxRun CLI

```bash
curl -fsSL https://boxlite.ai/boxrun/install | sh
# 安装到 ~/.boxrun/boxrun
```

启动 REST API：

```bash
~/.boxrun/boxrun serve --host 0.0.0.0 --port 9090
```

## 常见问题

### 1. Timeout waiting for guest ready (30s)

**错误信息：**

```
Failed to start BoxLite VM: engine reported an error: Timeout waiting for guest ready (30s).
Check logs: ~/.boxlite/logs/boxlite-shim.log, and system: dmesg | grep -i 'apparmor\|kvm'
```

**含义：** BoxLite 启动了 VM 进程（boxlite-shim），但 guest agent 未能在 30 秒内通过 Unix socket 报告就绪。

**排查步骤：**

#### 1a. BoxRun 与 BoxLite 版本不匹配（最常见）

BoxRun v0.3.0 内嵌的 boxlite 库版本较旧，与 boxlite v0.6.0 的 shim 存在不兼容。

**症状：** shim 日志显示 `Failed to parse config JSON: missing field 'exit_file'`

**根因：** BoxRun v0.3.0 生成的配置 JSON 缺少 `exit_file` 和 `stderr_file` 字段，但 boxlite v0.6.0 的 shim 要求这些字段。

**解决方案（Windows/WSL2）：** 创建一个 wrapper shim 脚本，在传给真实 shim 之前注入缺失字段：

```bash
# 备份原始 shim
mv ~/.boxrun/runtime/boxlite-shim ~/.boxrun/runtime/boxlite-shim-real

# 创建 wrapper
cat > ~/.boxrun/runtime/boxlite-shim << 'EOF'
#!/usr/bin/env python3
"""Shim wrapper: injects exit_file/stderr_file into config for boxrun v0.3.0 compatibility."""
import sys, json, os, tempfile

def main():
    args = list(sys.argv[1:])
    for i, arg in enumerate(args):
        if arg == '--config' and i + 1 < len(args):
            config_path = args[i + 1]
            with open(config_path) as f:
                config = json.load(f)
            box_dir = os.path.dirname(os.path.dirname(config_path))
            if 'exit_file' not in config:
                config['exit_file'] = os.path.join(box_dir, 'exit_status')
            if 'stderr_file' not in config:
                config['stderr_file'] = os.path.join(box_dir, 'stderr.log')
            with open(config_path, 'w') as f:
                json.dump(config, f)
            break
    real_shim = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'boxlite-shim-real')
    os.execv(real_shim, [real_shim] + args)

if __name__ == '__main__':
    main()
EOF
chmod +x ~/.boxrun/runtime/boxlite-shim
```

**解决方案（macOS）：** BoxRun v0.3.0 在 macOS 上还有额外问题（jailer 被禁用），wrapper shim 不够。建议直接使用 boxlite Python 库：

```python
import boxlite, asyncio

async def main():
    async with boxlite.SimpleBox(image='ubuntu:24.04', ports=[(7681, 7681)]) as box:
        r = await box.exec('echo', 'hello')
        print(r.stdout)

asyncio.run(main())
```

#### 1b. macOS 上 Jailer 被禁用

**症状：** 日志显示 `Jailer disabled, running shim without sandbox isolation`

BoxRun v0.3.0 在 macOS 上不启用 seatbelt sandbox，而 boxlite v0.6.0 需要 seatbelt 来正确隔离 VM 进程。

**对比：**

| | BoxRun v0.3.0 | boxlite Python v0.6.0 |
|---|---|---|
| Jailer | `Jailer disabled` | `sandbox="seatbelt"` |
| Shim 复制 | 直接使用 `~/.boxrun/runtime/boxlite-shim` | 复制到 `~/.boxlite/boxes/{id}/bin/` |
| Guest rootfs | 直接引用 image disk | Reflink + version key 管理 |
| 结果 | ❌ Timeout | ✅ 正常启动 |

**解决方案：** 在 macOS 上使用 boxlite Python 库而非 BoxRun。

#### 1c. Hypervisor entitlement 缺失

**症状：** shim 进程启动后立即退出，无日志输出。

macOS 上 `boxlite-shim` 必须具有 `com.apple.security.hypervisor` 签名权限才能使用 Hypervisor.framework。

**检查：**

```bash
codesign -d --entitlements - ~/.boxrun/runtime/boxlite-shim
# 应包含：
# com.apple.security.hypervisor = true
# com.apple.security.cs.disable-library-validation = true
```

**修复：**

```bash
cat > /tmp/entitlements.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.hypervisor</key>
    <true/>
</dict>
</plist>
EOF
codesign -f -s - --entitlements /tmp/entitlements.plist ~/.boxrun/runtime/boxlite-shim
```

### 2. Schema version mismatch

**错误信息：**

```
Schema version mismatch: database has v6, process expects v4.
Remove the database file in $BOXLITE_HOME/db to reset.
```

**根因：** boxlite v0.6.0 创建了 v6 schema 的数据库，但 BoxRun v0.3.0 期望 v4。

**解决方案：**

```bash
# 备份并删除数据库
mv ~/.boxlite/db/boxlite.db ~/.boxlite/db/boxlite.db.bak
rm -f ~/.boxlite/db/boxlite.db-shm ~/.boxlite/db/boxlite.db-wal
```

### 3. Runtime lock 冲突

**错误信息：**

```
Another BoxliteRuntime is already using directory: /Users/xxx/.boxlite
Only one runtime instance can use a BOXLITE_HOME directory at a time.
```

**根因：** 同一时间只能有一个 boxlite 运行时使用 `~/.boxlite` 目录（BoxRun 或 Python 库二选一）。

**解决方案：**

```bash
# 停止 BoxRun
pkill -f "boxrun serve"
# 清除锁文件
rm -f ~/.boxlite/.lock
```

### 4. Python 版本过低

**错误信息：**

```
ERROR: Could not find a version that satisfies the requirement boxlite
```

**根因：** boxlite 需要 Python 3.10+，macOS 系统自带 Python 3.9.6。

**解决方案：**

```bash
brew install python@3.12
/opt/homebrew/bin/python3.12 -m venv /tmp/boxlite-venv
source /tmp/boxlite-venv/bin/activate
pip install boxlite
```

### 5. 端口映射后网络不通

**症状：** 使用 `ports=[(7681, 7681)]` 后，VM 内 `apt-get update` 卡住。

**根因：** 端口映射可能影响 gvproxy 的网络转发。

**解决方案：** 避免在需要外部网络访问时使用端口映射。先在无端口映射的 box 中安装软件，或通过 `copy_in` / stdin pipe 注入二进制文件：

```python
# 通过 stdin pipe 注入二进制文件（不需要网络）
exec_obj = await box._box.exec("bash", args=["-c",
    "cat > /tmp/ttyd && chmod +x /tmp/ttyd"])
stdin_h = exec_obj.stdin()
with open('/tmp/ttyd.aarch64', 'rb') as f:
    await stdin_h.send_input(f.read())
await stdin_h.close()
await exec_obj.wait()
```

## ttyd WebSocket 协议

BoxLite adapter 的终端功能通过 ttyd 实现。ttyd 使用自定义的二进制 WebSocket 协议：

### 连接

```javascript
// 必须指定 'tty' 子协议
const ws = new WebSocket('ws://host:7681/ws', ['tty'])
ws.binaryType = 'arraybuffer'
```

### 握手

连接成功后，必须立即发送 JSON 握手消息：

```javascript
ws.onopen = () => {
  ws.send(JSON.stringify({
    AuthToken: '',        // 空字符串（无认证时）
    columns: 80,          // 终端列数
    rows: 24,             // 终端行数
  }))
}
```

### 消息格式

所有消息的第一个字节是类型标识（ASCII 字符）：

| 方向 | 类型字节 | ASCII | 含义 |
|------|---------|-------|------|
| 发送 | `0x30` | `'0'` | 用户输入 |
| 发送 | `0x31` | `'1'` | 终端 resize |
| 接收 | `0x30` | `'0'` | 终端输出 |

```javascript
// 发送输入
const TTYD_INPUT = '0'.charCodeAt(0)   // 0x30
const encoded = textEncoder.encode(userInput)
const msg = new Uint8Array(encoded.length + 1)
msg[0] = TTYD_INPUT
msg.set(encoded, 1)
ws.send(msg)

// 发送 resize
const TTYD_RESIZE = '1'.charCodeAt(0)  // 0x31
const json = JSON.stringify({ columns: cols, rows: rows })
const encoded = textEncoder.encode(json)
const msg = new Uint8Array(encoded.length + 1)
msg[0] = TTYD_RESIZE
msg.set(encoded, 1)
ws.send(msg)

// 接收输出
const TTYD_OUTPUT = '0'.charCodeAt(0)  // 0x30
ws.onmessage = (ev) => {
  const data = new Uint8Array(ev.data)
  if (data[0] === TTYD_OUTPUT) {
    terminal.write(textDecoder.decode(data.slice(1)))
  }
}
```

> **注意：** 类型字节是 ASCII `'0'`/`'1'`（0x30/0x31），不是数字 `0`/`1`（0x00/0x01）。这是一个常见的实现错误。

### 6. 自定义镜像无法使用（BoxLite 镜像管理）

**症状：** 本地用 Docker/OrbStack 构建了 `codebox:latest`，但 BoxLite 拉不到。

**根因：** BoxLite 有自己的镜像管理系统（OCI → ext4 rootfs），不共享 Docker/OrbStack 的镜像存储。公共镜像（如 `node:22-slim`）会从 Docker Hub 拉取，但本地构建的镜像不可见。

**解决方案 1（推荐）：rootfs_path + OCI layout**

将 Docker 镜像导出为 OCI layout 目录，BoxLite 直接加载本地文件，无需网络：

```bash
# 导出为 OCI layout
mkdir -p ~/.boxlite/codebox-oci
docker save codebox:latest | tar -xf - -C ~/.boxlite/codebox-oci

# 或用 skopeo（更规范）
skopeo copy docker-daemon:codebox:latest oci:~/.boxlite/codebox-oci:latest
```

在代码中使用：

```python
# Python
opts = boxlite.BoxOptions(rootfs_path='~/.boxlite/codebox-oci')
box = await runtime.create(opts)
```

```typescript
// TypeScript (Sandbank) — image 传绝对路径自动识别为 rootfs
const sandbox = await provider.create({ image: '~/.boxlite/codebox-oci' })
```

**解决方案 2：本地 registry（macOS 不可行）**

```bash
docker run -d -p 5000:5000 --name registry registry:2
docker tag codebox:latest localhost:5000/codebox:latest
docker push localhost:5000/codebox:latest
```

> **macOS 上此方案不可行：** BoxLite microVM 有独立网络栈，`localhost` 指向 VM 自身。即使用宿主机 IP，macOS 的网络隔离也会阻止 VM 访问宿主机端口。Linux 上可能可行。

**解决方案 3：推送到远程 registry**

推送到 GHCR 或 Docker Hub，BoxLite 从远程拉取（需网络，但最可靠）。

## 调试

### 启用详细日志

```bash
RUST_LOG=debug ~/.boxrun/boxrun serve --port 9090
```

### 查看日志文件

```bash
# BoxLite 运行时日志
cat ~/.boxlite/logs/boxlite.log.$(date +%Y-%m-%d)

# Shim 日志（如果存在）
cat ~/.boxlite/logs/boxlite-shim.log
```

### 清理所有状态（重新开始）

```bash
pkill -f "boxrun serve"
pkill -f boxlite-shim
rm -rf ~/.boxlite/boxes/
rm -f ~/.boxlite/.lock
rm -f ~/.boxlite/db/boxlite.db*
```

### 检查 macOS sandbox 拒绝

```bash
log stream --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "boxlite"'
```

## 版本兼容性矩阵

| BoxRun | boxlite (Python) | boxlite-shim | DB Schema | 兼容性 |
|--------|------------------|--------------|-----------|--------|
| v0.3.0 | — | v0.5.10 | v4 | ✅ (Linux/WSL2 only) |
| v0.3.0 | v0.6.0 | v0.6.0 | v4 vs v6 ❌ | ❌ 不兼容 |
| — | v0.6.0 | v0.6.0 | v6 | ✅ (Python 直接使用) |

**建议：** 在 BoxRun 更新到兼容 v0.6.0 之前，macOS 上优先使用 boxlite Python 库直接操作 VM。
