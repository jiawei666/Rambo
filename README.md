<p align="center">
  <a href="https://github.com/jiawei666/Rambo/releases/latest">
    <img src="assets/branding/app-logo-source.png" width="168" height="168" alt="Rambo logo" style="border-radius: 36px;" />
  </a>
</p>

<h1 align="center">Rambo</h1>

<p align="center">
  A personal AI agent that lives on your Mac.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/jiawei666/Rambo/releases/latest">Download</a> ·
  <a href="docs/product-decisions.md">Product decisions</a> ·
  <a href="docs/technical-design.md">Technical design</a>
</p>

<p align="center">
  <a href="https://github.com/jiawei666/Rambo/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/jiawei666/Rambo?style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20arm64-111111?style=flat-square" />
  <img alt="Built with Electron" src="https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848f?style=flat-square" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Codex%20App%20Server-222222?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

---

## Why Rambo?

I wanted to connect my own Codex App Server to a personal agent that runs on my Mac, keeps its own memory, and can work on my behalf throughout the day. **Rambo** is that project.

Rambo is built around an interface and interaction study of **Grok Bot**, reconstructed from its decompiled desktop app and UI assets. The underlying agent runtime is **Codex App Server**. The result is a local-first personal agent with a familiar Mac app experience.

> **Project status:** Rambo is under active development. The latest release is usable for day-to-day exploration, but it is not yet a fully acceptance-tested product. See [Project status](#project-status).

## Screenshots

### Connected apps

<p align="center">
  <a href="assets/screenshots/connected-apps.png">
    <img src="assets/screenshots/connected-apps.png" alt="Rambo connected apps screen showing Gmail, QQ Mail, WeChat, Calendar, and GitHub" width="100%" />
  </a>
</p>

<p align="center"><sub>Connect mail and local services once, then grant each Bot access independently.</sub></p>

### Daily planning and independent routines

<p align="center">
  <a href="assets/screenshots/life-manager-routines-light.png">
    <img src="assets/screenshots/life-manager-routines-light.png" alt="Rambo Bot turning a natural-language daily routine into separate planning, connected-app checks, meals, and fitness tasks" width="86%" />
  </a>
</p>

<p align="center"><sub>One natural-language brief becomes a day plan, connected-app checks, and independent routines for meals, fitness, and important follow-ups.</sub></p>

<p align="center"><sub>Account identifiers are redacted in these screenshots.</sub></p>

## Highlights

- **Runs locally on macOS.** Bots, chats, routines, settings, and memory stay on your Mac in a dedicated local data directory.
- **Uses your Codex account without a Rambo account.** Sign in to ChatGPT directly in Rambo, copy a local Codex configuration, or configure a compatible API. Rambo keeps its own isolated Codex Home.
- **Chat with connected apps.** Use QQ Mail and Gmail, and connect to a local WeChat environment when its permissions and local database access are available.
- **Plan work on your behalf.** Create one-time and recurring routines in natural language, with reminders, run history, retries, and catch-up behavior.
- **Bring multiple Bots into one conversation.** Bots can work in a shared group chat while keeping their own private chat, memory, model, and permission settings.
- **Control resources per Bot.** Choose which Skills, MCP servers, Apps, and Plugins are available to each Bot after they are added to the shared catalog.
- **Talk to your agent.** Start a live voice conversation, keep the transcript in chat, and continue with text when you are done.
- **Work with local files.** Preview images, PDFs, text, Markdown, CSV, audio, and video; drag files into the composer to insert their local paths; and ask a Bot to reference files outside its workspace.
- **Rich chat output.** Markdown, code with syntax highlighting, math, Mermaid diagrams, interactive question cards, structured result cards, media, and embedded MCP content share one chat surface.

## Features

### Local-first personal agent

Rambo is not tied to a browser tab or a hosted dashboard. It runs as a native macOS app, manages its own agent runtime, and keeps the product data on your machine. It is designed for a single person who wants a long-running assistant rather than another account-based SaaS product.

### Grok Bot interface study

The existing interface and interaction patterns are based on a reverse-engineering study of Grok Bot's desktop UI. Rambo follows that visual language where the behavior is already defined, then extends it with the features that make sense for a local personal agent.

This is an independent project. It is not affiliated with Grok, Google, OpenAI, or any of the connected services.

### Connected apps

Rambo has connectors for:

- **QQ Mail** — search, read, attach, draft, reply, and send through QQ Mail.
- **Gmail** — use either an app password or OAuth, with localized Gmail mailbox handling.
- **WeChat** — query chats and messages from a local WeChat environment after the required local setup and authorization.
- **Calendar, GitHub, and other MCP-backed services** — available through the MCP and resource system when configured.

Connections are scoped per Bot. A connection can be available to one Bot without being silently exposed to every other Bot.

### Routines and reminders

Ask a Bot to remember something, run a task later, or check in on a recurring schedule. Rambo supports:

- One-time and recurring routines
- Multiple discrete trigger times per day
- Natural-language creation and editing
- Pause, resume, run now, and stop controls
- Run history and delivery back to the originating Bot
- Catch-up rules after the app was not running

The scheduler runs locally. A saved schedule is not treated as proof that a future run actually happened; completed runs are recorded separately.

### Multi-Bot group chat

Create a group with multiple Bots and let them work in one shared timeline. Each member keeps its own private context, model, permissions, and resource switches. Group replies are not a disguised relay through one global Bot, and each member's work remains attributable.

### Per-Bot Skills, MCP, Apps, and Plugins

Rambo uses a three-layer resource model:

1. A discoverable catalog of local Skills, MCP servers, Apps, and Plugins.
2. A shared selectable catalog.
3. Independent switches for each Bot.

A new Bot copies the current shared defaults once. After creation, changing another Bot's switches or the shared defaults does not rewrite that Bot's configuration.

### Voice

Start a voice session from the Bot you are talking to. Live transcription is written into the chat, and the same Bot continues the conversation in text after the voice session ends.

### Chat workspace and files

The chat surface is designed as one continuous workspace: a floating Bot header, a scrollable transcript, and a composer that stays out of the way. Files can be previewed in-app, opened with a local application, revealed in Finder, or referenced directly from a Bot response.

Dragging a file into the composer inserts its absolute path. It does not upload or copy the file, and it does not create an attachment record unless you explicitly use the attachment workflow.

## How it works

```text
┌─────────────────────────────────────────────┐
│ Rambo.app                                   │
│  Electron + React + TypeScript              │
│                                             │
│  Bots · chats · groups · routines · memory  │
│  connectors · resource switches · files     │
└──────────────────────┬──────────────────────┘
                       │ stdio
┌──────────────────────▼──────────────────────┐
│ Codex App Server                            │
│  managed by Rambo as an isolated child      │
│  process                                    │
└──────────────────────┬──────────────────────┘
                       │
             isolated Codex configuration,
             authentication, and tool resources
```

Rambo bundles a verified macOS arm64 `codex-app-server` `0.165.0` baseline, so a clean installation can start without downloading a runtime. The app always launches its own stdio child process and keeps product data, chats, and runtime state in an isolated Codex Home. If a local Codex configuration exists, Rambo can copy the supported configuration and resource files into that isolated space. App Server updates are explicit and independent from app updates.

## Installation

Download the latest macOS arm64 build from [GitHub Releases](https://github.com/jiawei666/Rambo/releases/latest).

1. Unzip the downloaded archive.
2. Move `Rambo.app` to your Applications folder.
3. Because the app is not Developer ID signed or notarized, macOS Gatekeeper will block the first launch. Open **System Settings → Privacy & Security** and allow the app, or Control-click the app in Finder and choose **Open**.
4. Open the app and sign in to ChatGPT, copy a local Codex configuration, or configure a compatible API. A separate local Codex installation is not required for the bundled runtime.

The app has an ad-hoc local signature only. It is not a warning-free install and it does not carry a Developer ID certificate.

### Build from source

Requirements:

- macOS on Apple Silicon
- Node.js and npm
- Network access for dependency installation and initial runtime preparation

```sh
npm install
npm run dev
```

Useful commands:

```sh
npm run build          # Build the Electron application
npm run package:mac    # Build the unpacked macOS app
npm run typecheck      # TypeScript checks
npm run verify:fast    # Backend, acceptance, catalog, and ledger checks
```

Rambo uses an isolated Codex Home for its own configuration, authentication, sessions, and state. A local Codex Home is never shared in place; only explicitly supported configuration and resource files can be copied into Rambo's copy. Rambo conversations do not merge into the normal Codex history list.

## Project status

The current release is **v0.1.10**. The acceptance catalog tracks **157 product rules**, **277 local test cases**, **151 executable cases**, and **126 explicit implementation gaps**.

The deterministic checks and targeted Electron flows pass for the latest release, but this is not a claim that every product rule is complete. Real-device voice, external account flows, system-level behavior, and some full end-to-end workflows still require verification. The repository keeps the rule-level status and evidence separately so local tests are not mistaken for full product acceptance.

Read the [acceptance matrix](docs/acceptance-matrix.md), [test plan](docs/acceptance-test-plan.md), and [implementation progress](docs/implementation-progress.md) for details.

## Documentation

- [Product decisions](docs/product-decisions.md)
- [Technical design](docs/technical-design.md)
- [Acceptance matrix](docs/acceptance-matrix.md)
- [Acceptance test plan](docs/acceptance-test-plan.md)
- [Implementation progress](docs/implementation-progress.md)
- [File preview compatibility](docs/file-preview-compatibility.md)
- [Branding](docs/branding.md)

## License

Rambo is released under the [MIT License](LICENSE).

## Acknowledgements

Rambo's interface study builds on Grok Bot's desktop app. The agent runtime is based on Codex and Codex App Server. Thank you to the open-source projects that make Electron, React, Vite, Mermaid, KaTeX, and the local media tooling possible.
