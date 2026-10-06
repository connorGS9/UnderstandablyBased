# UnderstandablyBased

A desktop app for understanding a codebase. Open a folder and it works out what kind of program it is. Then it finds where work enters the code: HTTP routes, UI pages, `main()` functions, background jobs, and IPC channels. From any of those you can follow the code step by step, all the way to the database tables and external services it touches.

It is built for anyone who has to understand code they did not write, whether they are new to the language or senior and new to the repo.

Everything runs locally and offline. Nothing is sent anywhere.

## What you can do

- **Overview**: says what kind of program this is (web backend, full-stack app, low-latency/IPC system, CLI, library…) and shows the evidence for that. Also lists the frameworks detected, a language breakdown, and a "start here" list.
- **Explore**: pick a route, page, process, job or channel.
  - **Flow**: shows every function the request passes through, colored by role: middleware → controller → service → data access → table / external API / channel.
  - **Double-click** a box to read its code. Calls are underlined, so **click a call** to follow it into the next function. The breadcrumb trail records how you got there; click any step, or Home, to jump back. Back/Forward work like a browser (Alt+←/→ or mouse buttons).
  - **Inspector**: explains what each piece of code does in plain language, why we think so, what it calls, what calls it, which routes reach it, and which data it touches.
- **Diagrams**:
  - **Data flow**: an architecture view with columns from entry points to data stores. Click a box to highlight what it talks to.
  - **Database**: an ER diagram with primary keys, foreign keys and indexes, plus the code that reads or writes each table.
  - **Route map**: every URL as a tree of path segments.
  - **Modules**: which folders depend on which.
- **Search** (Ctrl/⌘+K): routes, functions, classes, files and tables.
- **Stays current**: when you edit files the analysis refreshes on its own; only changed files are re-read. The ⟳ button re-analyzes on demand.
- **Adjustable**: the panels resize (drag their borders), and light and dark themes are both available.
- **Tips for newcomers**: the first time you reach each screen, a short tip explains it and highlights what it's talking about. Each opened codebase also gets a welcome tip with where to start. Click **Turn off tips** on any tip to stop them (with an immediate Undo). The 💡 button in the top bar turns them back on or replays them all.

## When the analysis is not quite right

Every project is a little different, so you can correct the map (⚙ **Project settings** in the top bar):

- **Ignore folders and files** using gitignore-style patterns (`legacy/`, `**/generated/**`).
- **Tests**: automatic (skipped only in very large projects), always included, or always skipped.
- **Override the program type** if the detection guessed wrong.
- **Role corrections**: "OrderStore is really data access". In the Inspector, click **Wrong role?** to fix it. A rule can match a class or function name, `Class.method`, or a path pattern.
- **Pinned entry points**: start flows from code the analyzer didn't recognize as an entry point (CLI commands, message handlers, scripts). Use **Pin as entry point** in the Inspector.

These settings are saved per project on your machine. To share them with your team, commit an `understandably.json` with the same fields to the project root; the settings dialog shows the JSON to copy. Everyone starts from the repo file, and their own changes take priority.

```json
{
  "exclude": ["legacy/", "scripts/"],
  "tests": "auto",
  "roleOverrides": [{ "match": "src/adapters/**", "role": "client" }],
  "entryPoints": [{ "symbol": "Worker.processQueue" }],
  "projectKind": "web-backend",
  "autoRefresh": true
}
```

Every inferred link has a confidence level: **certain** (explicit in the code), **likely** (via an interface, inheritance, or a framework convention) or **guess** (matched by name only). Guesses are drawn dotted and can be hidden.

## Getting started

Requirements: Node.js 22+.

```bash
npm install
npm run dev                 # launch the desktop app (hot reload)
npm run dev -- ~/code/repo  # ...and open a folder straight away
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev:web` | Same UI in a normal browser at http://localhost:5317 (type a folder path, or use `?open=/path`). |
| `npm test` | Engine regression tests against the projects in `test/fixtures/`. |
| `npm run inspect -- <folder>` | Print what the engine finds (entry points, tables, a sample flow) without the UI. |
| `npm run typecheck` | Type-check everything. |
| `npm run dist` | Build installers: AppImage + .deb on Linux, .dmg on macOS, NSIS on Windows. Run on each target OS. |
| `npm run dist:dir` | Build an unpacked app in `release/` for quick testing. |

If `npm install` didn't download Electron (npm 11 blocks install scripts by default), run `npx install-electron`.

## What it understands

| Area | Supported |
| --- | --- |
| Languages | TypeScript/JavaScript (incl. JSX/TSX), Java, Python, Go, C, C++, Rust, C# |
| HTTP routes | Spring MVC, JAX-RS, NestJS (and `@RestController`/`@JsonController` styles), ASP.NET Core (attributes and minimal APIs), Express/Koa/Fastify/Hono (including nested routers, `app.use` prefixes and middleware), FastAPI/Flask (routers, blueprints, prefixes from settings), Django `urls.py` (`include()`, class-based views), Gin/Echo/Chi/Fiber/net/http (groups), Axum |
| Pages | Next.js app and pages routers, React Router (`<Route>` and route objects), Vue Router, Angular Router (including nested `loadComponent`), TanStack Router (`createFileRoute`). Vue and Svelte single-file components are analyzed through their `<script>` blocks. |
| Processes & jobs | `main()` in every language, Python `__main__`, Node entry scripts, `@Scheduled`, Celery tasks, Kafka/Rabbit/JMS listeners |
| Databases | SQL DDL (`CREATE TABLE`/`INDEX`, `ALTER TABLE`), Prisma, JPA/Hibernate, TypeORM, Django models, SQLAlchemy/SQLModel. Table usage is detected from SQL in strings, ORM model calls, Prisma clients and typed repositories |
| External calls | `fetch`, axios, requests/httpx, RestTemplate/WebClient, HttpClient, Go `net/http`, libcurl |
| IPC & messaging | POSIX/Boost shared memory, message queues, named pipes, ZeroMQ/nanomsg/Aeron endpoints, Kafka/RabbitMQ/Redis/NATS topics |

## How it works

```
folder ─► scan ─► parse (tree-sitter, in a worker) ─► code graph ─► roles ─► DB schema ─► sinks ─► entry points ─► profile
                                                         │                                                         │
                                                         └──────────── flows, diagrams, code links, search ◄────────┘
```

- `src/engine/extract/*`: one extractor per language. Each turns a syntax tree into facts: symbols, calls, imports, fields, typed variables, annotations and interesting string literals.
- `src/engine/graph.ts`: links calls to definitions across files using imports, TS path aliases, Python packages, Go modules, field/parameter/local types, type aliases, inheritance and interface → implementation, and overloads by arity.
- `src/engine/roles.ts`: decides whether each class or function is a controller, service, repository and so on, using annotations, base classes, names, file names and folders.
- `src/engine/routes.ts`: framework-specific entry point detection, including router mounting and prefixes.
- `src/engine/db.ts` and `src/engine/sinks.ts`: database schema, and where code touches tables, HTTP services and channels.
- `src/engine/project.ts`: orchestrates indexing and answers UI queries (flows, symbol details, file views, search).
- `electron/`: desktop shell. Indexing runs in a worker thread so the window never freezes.
- `src/renderer/`: React UI (React Flow + ELK for diagrams, Monaco for code).

Very large repositories (over 4,000 source files) skip test files to stay fast. As a reference point, n8n (22k files) indexes in about 15 seconds.

## Roadmap

- Hover explanations of language keywords and library APIs (e.g. what `constexpr` means in C++).
- Send real requests to a route from the app (curl-style) and see the response next to the flow.
- A UI inspector for frontends: point at part of the running app and see the code that renders it.
- Open a Git URL directly (clone into a cache).
- Link frontend API calls to the backend routes they hit, so a flow can continue across the network.
- Parallel parsing for very large repositories.
- More languages and frameworks: Kotlin, Ruby/Rails, PHP/Laravel, Spring WebFlux functional routes.
- Monorepo scoping: focus the map on one package or service at a time.
- An optional precise mode using language servers / SCIP indexes for compiler-accurate links.
