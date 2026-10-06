import type { EntryPoint, Evidence, FileEntry, ProjectKind, ProjectProfile } from './types';
import type { CodeGraph } from './graph';

interface Manifest {
  file: string;
  text: string;
}

interface FrameworkRule {
  name: string;
  category: 'web-backend' | 'web-frontend' | 'orm' | 'game' | 'low-latency' | 'cli' | 'desktop' | 'messaging' | 'testing';
  /** Regex tested against manifest text (package.json deps, pom.xml, requirements...). */
  manifest?: RegExp;
  manifestFiles?: RegExp;
  /** Regex tested against import sources. */
  imports?: RegExp;
  /** Marker files */
  files?: RegExp;
}

const RULES: FrameworkRule[] = [
  { name: 'Spring Boot', category: 'web-backend', manifest: /spring-boot-starter-web|spring-boot-starter-webflux|org\.springframework\.boot/, manifestFiles: /pom\.xml|build\.gradle/ },
  { name: 'Spring Data JPA', category: 'orm', manifest: /spring-boot-starter-data-jpa|hibernate-core|jakarta\.persistence/, manifestFiles: /pom\.xml|build\.gradle/ },
  { name: 'Quarkus', category: 'web-backend', manifest: /io\.quarkus/, manifestFiles: /pom\.xml|build\.gradle/ },
  { name: 'Micronaut', category: 'web-backend', manifest: /io\.micronaut/, manifestFiles: /pom\.xml|build\.gradle/ },
  { name: 'Express', category: 'web-backend', manifest: /"express"\s*:/, manifestFiles: /package\.json/ },
  { name: 'NestJS', category: 'web-backend', manifest: /"@nestjs\/core"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Fastify', category: 'web-backend', manifest: /"fastify"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Koa', category: 'web-backend', manifest: /"koa"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Hono', category: 'web-backend', manifest: /"hono"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Next.js', category: 'web-frontend', manifest: /"next"\s*:/, manifestFiles: /package\.json/ },
  { name: 'React', category: 'web-frontend', manifest: /"react"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Vue', category: 'web-frontend', manifest: /"vue"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Angular', category: 'web-frontend', manifest: /"@angular\/core"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Svelte', category: 'web-frontend', manifest: /"svelte"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Electron', category: 'desktop', manifest: /"electron"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Prisma', category: 'orm', manifest: /"(@prisma\/client|prisma)"\s*:/, manifestFiles: /package\.json/ },
  { name: 'TypeORM', category: 'orm', manifest: /"typeorm"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Sequelize', category: 'orm', manifest: /"sequelize"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Mongoose', category: 'orm', manifest: /"mongoose"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Drizzle', category: 'orm', manifest: /"drizzle-orm"\s*:/, manifestFiles: /package\.json/ },
  { name: 'Commander/Yargs CLI', category: 'cli', manifest: /"(commander|yargs|oclif|@oclif\/core|cac|meow)"\s*:/, manifestFiles: /package\.json/ },
  { name: 'FastAPI', category: 'web-backend', manifest: /^\s*fastapi\b|["']fastapi/im, manifestFiles: /requirements.*\.txt|pyproject\.toml|Pipfile|setup\.py/ },
  { name: 'Flask', category: 'web-backend', manifest: /^\s*flask\b|["']flask/im, manifestFiles: /requirements.*\.txt|pyproject\.toml|Pipfile|setup\.py/ },
  { name: 'Django', category: 'web-backend', manifest: /^\s*django\b|["']django/im, manifestFiles: /requirements.*\.txt|pyproject\.toml|Pipfile|setup\.py/ },
  { name: 'SQLAlchemy', category: 'orm', manifest: /sqlalchemy|sqlmodel/i, manifestFiles: /requirements.*\.txt|pyproject\.toml|Pipfile|setup\.py/ },
  { name: 'Click/Typer CLI', category: 'cli', manifest: /^\s*(click|typer)\b|["'](click|typer)/im, manifestFiles: /requirements.*\.txt|pyproject\.toml|Pipfile|setup\.py/ },
  { name: 'Pygame', category: 'game', manifest: /pygame/i, manifestFiles: /requirements.*\.txt|pyproject\.toml/ },
  { name: 'Gin', category: 'web-backend', manifest: /github\.com\/gin-gonic\/gin/, manifestFiles: /go\.mod/ },
  { name: 'Echo', category: 'web-backend', manifest: /github\.com\/labstack\/echo/, manifestFiles: /go\.mod/ },
  { name: 'Chi', category: 'web-backend', manifest: /github\.com\/go-chi\/chi/, manifestFiles: /go\.mod/ },
  { name: 'Fiber', category: 'web-backend', manifest: /github\.com\/gofiber\/fiber/, manifestFiles: /go\.mod/ },
  { name: 'Gorilla mux', category: 'web-backend', manifest: /github\.com\/gorilla\/mux/, manifestFiles: /go\.mod/ },
  { name: 'GORM', category: 'orm', manifest: /gorm\.io\/gorm/, manifestFiles: /go\.mod/ },
  { name: 'Cobra CLI', category: 'cli', manifest: /github\.com\/spf13\/cobra|github\.com\/urfave\/cli/, manifestFiles: /go\.mod/ },
  { name: 'net/http', category: 'web-backend', imports: /^net\/http$/ },
  { name: 'Axum', category: 'web-backend', manifest: /^\s*axum\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'Actix Web', category: 'web-backend', manifest: /^\s*actix-web\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'Rocket', category: 'web-backend', manifest: /^\s*rocket\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'Bevy', category: 'game', manifest: /^\s*bevy\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'Clap CLI', category: 'cli', manifest: /^\s*clap\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'Tokio', category: 'low-latency', manifest: /^\s*tokio\s*=/m, manifestFiles: /Cargo\.toml/ },
  { name: 'ASP.NET Core', category: 'web-backend', manifest: /Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/, manifestFiles: /\.csproj$/ },
  { name: 'Entity Framework', category: 'orm', manifest: /Microsoft\.EntityFrameworkCore/, manifestFiles: /\.csproj$/ },
  { name: 'Unity', category: 'game', imports: /^UnityEngine/ },
  { name: 'Unreal Engine', category: 'game', files: /\.uproject$/ },
  { name: 'Godot', category: 'game', files: /(^|\/)project\.godot$/ },
  { name: 'SDL', category: 'game', imports: /^SDL2?\/|^SDL\.h$|^SDL2\.h$/ },
  { name: 'SFML', category: 'game', imports: /^SFML\// },
  { name: 'raylib', category: 'game', imports: /^raylib\.h$/ },
  { name: 'OpenGL/Vulkan', category: 'game', imports: /^(GL\/|GLFW\/|glad\/|vulkan\/)/ },
  { name: 'Boost.Interprocess', category: 'low-latency', imports: /^boost\/interprocess/ },
  { name: 'Boost.Asio', category: 'low-latency', imports: /^boost\/asio|^asio\.hpp$/ },
  { name: 'ZeroMQ', category: 'messaging', imports: /^zmq\.h(pp)?$|^zmq$|^zmq\b|^github\.com\/pebbe\/zmq/ },
  { name: 'Aeron', category: 'low-latency', imports: /^Aeron\.h$|^aeron\// },
  { name: 'QuickFIX', category: 'low-latency', imports: /^quickfix\// },
  { name: 'POSIX shared memory', category: 'low-latency', imports: /^sys\/mman\.h$|^sys\/shm\.h$/ },
  { name: 'Kafka', category: 'messaging', manifest: /kafka/i, manifestFiles: /pom\.xml|build\.gradle|package\.json|requirements.*\.txt|go\.mod|Cargo\.toml|\.csproj$/ },
  { name: 'RabbitMQ', category: 'messaging', manifest: /amqp|rabbitmq|spring-boot-starter-amqp/i, manifestFiles: /pom\.xml|build\.gradle|package\.json|requirements.*\.txt|go\.mod|\.csproj$/ },
  { name: 'Qt', category: 'desktop', imports: /^Q[A-Z]\w+$|^QtCore|^QtWidgets/ },
];

const KIND_LABEL: Record<ProjectKind, string> = {
  'web-backend': 'Web backend / API',
  'web-frontend': 'Web frontend',
  'fullstack-web': 'Full-stack web app',
  'low-latency': 'Low-latency / systems (IPC, trading-style)',
  game: 'Game',
  cli: 'Command-line tool',
  library: 'Library',
  desktop: 'Desktop app',
  generic: 'General program',
};

const LANG_LABEL: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript (TSX)',
  java: 'Java',
  python: 'Python',
  c: 'C',
  cpp: 'C++',
  go: 'Go',
  rust: 'Rust',
  csharp: 'C#',
};

export function detectProfile(graph: CodeGraph, files: FileEntry[], manifests: Manifest[], extras: string[], entries: EntryPoint[]): ProjectProfile {
  const frameworks: ProjectProfile['frameworks'] = [];
  const allImports: { source: string; file: string; line: number }[] = [];
  for (const [file, f] of graph.facts) for (const i of f.imports) allImports.push({ source: i.source, file, line: i.line });

  for (const rule of RULES) {
    const ev: Evidence[] = [];
    if (rule.manifest) {
      for (const m of manifests) {
        if (rule.manifestFiles && !rule.manifestFiles.test(m.file)) continue;
        const match = rule.manifest.exec(m.text);
        if (match) ev.push({ text: `${m.file} mentions "${match[0].trim().replace(/["':=]/g, '').trim()}"`, file: m.file, line: m.text.slice(0, match.index).split('\n').length });
      }
    }
    if (rule.imports) {
      const hits = allImports.filter((i) => rule.imports!.test(i.source));
      if (hits.length) ev.push({ text: `${hits.length} import${hits.length > 1 ? 's' : ''} of ${hits[0].source}`, file: hits[0].file, line: hits[0].line });
    }
    if (rule.files) {
      const hit = extras.find((e) => rule.files!.test(e)) ?? files.find((f) => rule.files!.test(f.path))?.path;
      if (hit) ev.push({ text: `found ${hit}`, file: hit });
    }
    if (ev.length) frameworks.push({ name: rule.name, category: rule.category, evidence: ev.slice(0, 3) });
  }

  // Language breakdown
  const langMap = new Map<string, { files: number; lines: number }>();
  for (const f of files) {
    if (!f.lang) continue;
    const key = LANG_LABEL[f.lang === 'tsx' ? 'typescript' : f.lang] ?? f.lang;
    const cur = langMap.get(key) ?? { files: 0, lines: 0 };
    cur.files++;
    cur.lines += f.lines;
    langMap.set(key, cur);
  }
  const languages = [...langMap.entries()].map(([lang, v]) => ({ lang, ...v })).sort((a, b) => b.lines - a.lines);

  // Score project kinds
  const scores = new Map<ProjectKind, { score: number; evidence: Evidence[] }>();
  const bump = (k: ProjectKind, s: number, e: Evidence) => {
    const cur = scores.get(k) ?? { score: 0, evidence: [] };
    cur.score += s;
    if (cur.evidence.length < 5) cur.evidence.push(e);
    scores.set(k, cur);
  };
  for (const fw of frameworks) {
    const e = { text: `${fw.name}: ${fw.evidence[0].text}`, file: fw.evidence[0].file, line: fw.evidence[0].line };
    if (fw.category === 'web-backend') bump('web-backend', 5, e);
    if (fw.category === 'web-frontend') bump('web-frontend', fw.name === 'React' || fw.name === 'Vue' ? 3 : 4, e);
    if (fw.category === 'game') bump('game', 6, e);
    if (fw.category === 'low-latency') bump('low-latency', 3, e);
    if (fw.category === 'messaging') bump('low-latency', 1, e);
    if (fw.category === 'cli') bump('cli', 3, e);
    if (fw.category === 'desktop') bump('desktop', 4, e);
  }
  const routes = entries.filter((e) => e.kind === 'http-route');
  const pages = entries.filter((e) => e.kind === 'page');
  const processes = entries.filter((e) => e.kind === 'process');
  const channels = entries.filter((e) => e.kind === 'channel');
  if (routes.length) bump('web-backend', Math.min(8, 2 + routes.length / 4), { text: `${routes.length} HTTP route${routes.length > 1 ? 's' : ''} detected`, file: routes[0].file, line: routes[0].line });
  if (pages.length) bump('web-frontend', Math.min(6, 2 + pages.length / 4), { text: `${pages.length} page route${pages.length > 1 ? 's' : ''} detected`, file: pages[0].file, line: pages[0].line });
  if (channels.length) bump('low-latency', Math.min(6, 2 + channels.length), { text: `${channels.length} IPC/messaging channel${channels.length > 1 ? 's' : ''}: ${channels.slice(0, 3).map((c) => c.label).join(', ')}` });
  if (processes.length > 1 && (languages[0]?.lang === 'C++' || languages[0]?.lang === 'C' || languages[0]?.lang === 'Rust')) bump('low-latency', 2, { text: `${processes.length} separate executables (main functions)` });

  // Low-latency code signals (C/C++/Rust)
  let perfSignals = 0;
  const perfEvidence: Evidence[] = [];
  for (const [file, f] of graph.facts) {
    if (f.lang !== 'c' && f.lang !== 'cpp' && f.lang !== 'rust') continue;
    for (const c of f.calls) {
      if (/^(pthread_setaffinity_np|sched_setaffinity|_mm_pause|__builtin_expect|rdtsc|__rdtsc|_mm_prefetch|__builtin_prefetch|mlockall|clock_gettime|set_thread_affinity|fetch_add|compare_exchange_weak|compare_exchange_strong|epoll_wait|io_uring_submit)$/.test(c.callee)) {
        perfSignals++;
        if (perfEvidence.length < 2) perfEvidence.push({ text: `${c.callee}() call`, file, line: c.range.sl });
      }
    }
  }
  if (perfSignals) bump('low-latency', Math.min(5, perfSignals / 2), perfEvidence[0] ? { ...perfEvidence[0], text: `${perfSignals} low-latency primitives (CPU pinning, atomics, prefetch, busy-wait…), e.g. ${perfEvidence[0].text}` } : { text: 'low-latency primitives' });

  const be = scores.get('web-backend');
  const fe = scores.get('web-frontend');
  if (be && fe && be.score >= 4 && fe.score >= 3) {
    scores.set('fullstack-web', { score: be.score + fe.score, evidence: [...be.evidence.slice(0, 2), ...fe.evidence.slice(0, 2)] });
  }
  if (!scores.size || [...scores.values()].every((s) => s.score < 3)) {
    if (processes.length) bump('generic', 3, { text: `${processes.length} program entry point${processes.length > 1 ? 's' : ''}`, file: processes[0].file, line: processes[0].line });
    else bump('library', 2, { text: 'no entry points found; treating as a library' });
  }

  const kinds = [...scores.entries()]
    .map(([kind, v]) => ({ kind, label: KIND_LABEL[kind], score: Math.round(v.score * 10) / 10, evidence: v.evidence }))
    .sort((a, b) => b.score - a.score);
  return { kinds, frameworks, languages };
}
