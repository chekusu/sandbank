# @sandbank.dev/devices

> Give an AI assistant its user's own cloud desktop, browser and Android phone, on [Sandbank Cloud](https://sandbank.dev/cloud) `/v2` sessions.

One session is one device for one end user (`owner`). Creating it is idempotent: the first call boots it, later calls get the same device back, an idle device stops after 30 minutes and keeps its files and sign-ins. The user can take a device over from a one-time link, or type a password into it on a page the assistant never sees.

The package has three parts:

- **Client** (`SandbankDevices`): sessions, screenshots, UI element lists (phone), input steps, shell commands (desktop/browser), takeover and secure input links, warm-up.
- **Tools**: `phone`, `computer`, `browser` and `run_command`, each a name, a description, JSON Schema parameters and an `execute`. They do not depend on any agent framework.
- **Adapters**: `@sandbank.dev/devices/pi` for [Pi](https://www.npmjs.com/package/@earendil-works/pi-durable), `@sandbank.dev/devices/openai` for OpenAI-style function calling (also DeepSeek).

It only uses `fetch`, so it runs in Cloudflare Workers, Node 20+ and Bun.

## Install

```bash
pnpm add @sandbank.dev/devices
```

## Usage

```ts
import { SandbankDevices, createDeviceTools } from '@sandbank.dev/devices'
import { toOpenAITool, runDeviceToolCall, toChatMessages } from '@sandbank.dev/devices/openai'

// SANDBANK_API_TOKEN is your tenant key (sbk_…); null when unset.
const devices = SandbankDevices.fromEnv(env)
const tools = devices ? createDeviceTools(devices, ['computer', 'phone', 'command']) : []

// Offer them to the model:
const request = { model, messages, tools: tools.map(toOpenAITool) }

// Run a call the model made:
const result = await runDeviceToolCall(tools, call.function.name, call.function.arguments, {
  owner: userId,
  // Optional: show takeover / secure input links as cards in your own UI. Return false to have the
  // assistant send the link as text instead.
  showCard: (card) => { pendingCards.push(card); return true },
})
messages.push(...toChatMessages(call.id, call.function.name, result!))
```

With Pi:

```ts
import { toPiTool } from '@sandbank.dev/devices/pi'

const phone = toPiTool(createPhoneTool(devices), (api) => ({ owner: userId }))
```

Warm the user's devices when they send a message, so the first step does not wait for a boot:

```ts
ctx.waitUntil(Promise.all([devices.warm('phone', userId), devices.warm('desktop', userId)]))
```

## Who may use it

Sandbank Cloud only checks the tenant key; your product decides which of its users get devices. `accessMode` and `d1Allowlist` implement the usual switch (`all`, `allowlist`, `off`) over a D1 table:

```ts
import { accessMode, d1Allowlist, deviceAccessAllowed } from '@sandbank.dev/devices'

const list = d1Allowlist(env.DB, 'cloud_computer_access')
const allowed = await deviceAccessAllowed(accessMode(env.CLOUD_COMPUTER_ACCESS), userId, list.has)
```

Hide the tools from users who are not allowed, and refuse their calls.

## Links

Takeover and secure input links are always `https://<your Sandbank Cloud host>/v2/p/<token>/` or `/phonebox/p/<token>/`. The client refuses any other link (`trustedLink`), so a link shown to a user cannot point elsewhere.

## License

MIT
