import ignore from 'ignore';
import type { CodeSymbol, ProjectSettings, Role } from './types';

const ANNOTATION_ROLES: [RegExp, Role][] = [
  [/^(RestController|Controller|ApiController|RequestMapping)$/, 'controller'],
  [/^(Service|Injectable|Component|UseCase|ApplicationScoped|Singleton)$/, 'service'],
  [/^(Repository|Mapper|Dao|EntityRepository)$/, 'repository'],
  [/^(Entity|Table|Document|MappedSuperclass|Embeddable|Schema|Model)$/, 'model'],
  [/^(Configuration|ConfigurationProperties|SpringBootApplication|Module|EnableWebSecurity)$/, 'config'],
  [/^(Test|ParameterizedTest|SpringBootTest|WebMvcTest|DataJpaTest|Fact|Theory|TestMethod|pytest\.fixture)$/, 'test'],
  [/^(ControllerAdvice|RestControllerAdvice|WebFilter|Aspect|Middleware)$/, 'middleware'],
];

const SUPER_ROLES: [RegExp, Role][] = [
  [/^(JpaRepository|CrudRepository|PagingAndSortingRepository|MongoRepository|ReactiveCrudRepository|ListCrudRepository|Repository|JpaSpecificationExecutor|DbContext)$/, 'repository'],
  [/^(models\.Model|Model|Base|DeclarativeBase|SQLModel|Document|BaseEntity|ActiveRecord::Base|ApplicationRecord)$/, 'model'],
  [/^(ControllerBase|Controller|APIView|ViewSet|ModelViewSet|GenericAPIView|View|TemplateView|ListView|DetailView|CreateView|Resource|MethodView)$/, 'controller'],
  [/^(OncePerRequestFilter|Filter|HandlerInterceptor|MiddlewareMixin|BaseHTTPMiddleware|CanActivate|NestMiddleware)$/, 'middleware'],
  [/^(MonoBehaviour|ScriptableObject|Node|Node2D|Node3D|AActor|UObject|APawn|ACharacter|UActorComponent)$/, 'service'],
  [/^(TestCase|unittest\.TestCase|APITestCase)$/, 'test'],
  [/^(React\.Component|Component|PureComponent)$/, 'view'],
];

const NAME_ROLES: [RegExp, Role][] = [
  [/(Controller|Resource|Endpoint|Endpoints|Handler|Handlers|Routes|Router|Views?|ViewSet|Api)$/, 'controller'],
  [/(Service|Services|UseCase|Interactor|Manager|Facade|Provider|Engine|Processor|Strategy|Worker)$/, 'service'],
  [/(Repository|Repo|Dao|DAO|Store|Mapper|Persistence|Storage|Db|Database)$/, 'repository'],
  [/(Entity|Model|Dto|DTO|Schema|Record|Request|Response|Payload)$/, 'model'],
  [/(Middleware|Interceptor|Filter|Guard|Pipe|Advice)$/, 'middleware'],
  [/(Client|HttpClient|ApiClient|Adapter|Connector|Publisher|Producer|Consumer|Subscriber|Gateway|Session|Socket|Connection)$/, 'client'],
  [/(Config|Configuration|Settings|Options|Properties|Module)$/, 'config'],
  [/(Util|Utils|Helper|Helpers|Tools)$/, 'util'],
  [/(Test|Tests|Spec|IT)$/, 'test'],
  [/(Page|Screen|Component|Layout|Widget|Dialog|Modal|Form)$/, 'view'],
];

const PATH_ROLES: [RegExp, Role][] = [
  [/(^|\/)(__tests__|tests?|spec|specs|testing|e2e)\//i, 'test'],
  [/\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|cs|kt)$/, 'test'],
  [/(^|\/)(middlewares?|interceptors?|guards?|filters?)\//i, 'middleware'],
  [/(^|\/)(controllers?|routes?|routers?|handlers?|endpoints?|api|resources|views)\//i, 'controller'],
  [/(^|\/)(services?|usecases?|use_cases|domain|application|core|business|logic|interactors?)\//i, 'service'],
  [/(^|\/)(repositor(y|ies)|dao|daos|db|database|data|store|stores|persistence|storage|crud|queries|mappers?)\//i, 'repository'],
  [/(^|\/)(models?|entities|entity|schemas?|dto|dtos|types|domain\/model)\//i, 'model'],
  [/(^|\/)(clients?|integrations?|adapters?|external|gateways?|sdk)\//i, 'client'],
  [/(^|\/)(components?|pages|screens|layouts?|ui|widgets|templates|app\/.*\/page\.[jt]sx?$)/i, 'view'],
  [/(^|\/)(utils?|helpers?|lib|libs|common|shared|pkg)\//i, 'util'],
  [/(^|\/)(config|configs|settings|conf)\//i, 'config'],
];

const DJANGO_VIEW = /(^|\/)views\.py$/;

/** File naming conventions: article.service.ts, user_repository.py, order_handler.go, models.py */
const FILE_ROLES: [RegExp, Role][] = [
  [/[._-](controller|controllers|resource|endpoint|endpoints|handler|handlers|routes?|router|api|views?)\.\w+$|(^|\/)(views|routes|handlers|endpoints|api)\.\w+$/i, 'controller'],
  [/[._-](service|services|usecase|interactor|manager)\.\w+$|(^|\/)(services|service)\.\w+$/i, 'service'],
  [/[._-](repository|repositories|repo|dao|store|queries|crud|db)\.\w+$|(^|\/)(crud|repository|queries|db|database)\.\w+$/i, 'repository'],
  [/[._-](model|models|entity|entities|schema|schemas|dto|dtos|types)\.\w+$|(^|\/)(models|schemas|entities|types)\.\w+$/i, 'model'],
  [/[._-](middleware|middlewares|guard|guards|interceptor|filter)\.\w+$|(^|\/)(middleware|middlewares|deps|dependencies|auth)\.\w+$/i, 'middleware'],
  [/[._-](client|clients|gateway|adapter|sdk|api-client)\.\w+$|(^|\/)(client|clients)\.\w+$/i, 'client'],
  [/[._-](config|configuration|settings|module)\.\w+$|(^|\/)(config|settings|configuration)\.\w+$/i, 'config'],
  [/[._-](util|utils|helper|helpers)\.\w+$|(^|\/)(utils|helpers|util)\.\w+$/i, 'util'],
];

/** Assigns a role to every symbol. Class-level evidence wins; methods inherit from their class. */
export function assignRoles(symbols: Map<string, CodeSymbol>) {
  const classRole = (s: CodeSymbol): { role: Role; reason: string } | undefined => {
    for (const a of s.annotations) {
      const name = a.name.split('.').pop()!;
      for (const [re, role] of ANNOTATION_ROLES) {
        if (re.test(name)) {
          // NestJS @Injectable is used for repositories too; let the name refine it.
          if (name === 'Injectable' || name === 'Component') {
            const byName = NAME_ROLES.find(([r]) => r.test(s.name));
            if (byName) return { role: byName[1], reason: `@${name} and name "${s.name}"` };
          }
          return { role, reason: `@${name} annotation` };
        }
      }
    }
    for (const sup of s.supers ?? []) {
      for (const [re, role] of SUPER_ROLES) {
        if (re.test(sup) || re.test(sup.split('.').pop()!)) {
          if (sup === 'Base' && !/models?|entit|schema|db/i.test(s.file)) continue;
          if (role === 'view' && !/\.(tsx|jsx)$/.test(s.file)) continue;
          if (/^(Node|Node2D|Node3D)$/.test(sup) && s.lang !== 'csharp' && s.lang !== 'cpp') continue;
          return { role, reason: `extends ${sup}` };
        }
      }
    }
    for (const [re, role] of NAME_ROLES) {
      // "Handler" in systems code (feed handler, signal handler) is not an HTTP controller.
      if (role === 'controller' && (s.lang === 'c' || s.lang === 'cpp' || s.lang === 'rust') && !/Controller$/.test(s.name)) continue;
      if (re.test(s.name)) return { role, reason: `name ends with "${re.exec(s.name)![1]}"` };
    }
    return undefined;
  };

  const SYSTEMS = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|rs)$/;
  const UI_FILE = /\.(tsx|jsx|vue|svelte)$/;
  const pathRole = (file: string): { role: Role; reason: string } | undefined => {
    const r = pathRoleRaw(file);
    // Frontend route folders hold screens, not HTTP handlers.
    if (r?.role === 'controller' && UI_FILE.test(file)) return { role: 'view', reason: r.reason };
    // In systems code a "handler"/"api" file is not an HTTP controller.
    if (r?.role === 'controller' && SYSTEMS.test(file)) return undefined;
    return r;
  };
  const pathRoleRaw = (file: string): { role: Role; reason: string } | undefined => {
    if (DJANGO_VIEW.test(file)) return { role: 'controller', reason: 'Django views.py' };
    const testHit = PATH_ROLES.slice(0, 2).find(([re]) => re.test(file));
    if (testHit) return { role: 'test', reason: 'test file' };
    const base = file.split('/').pop()!;
    for (const [re, role] of FILE_ROLES) if (re.test(base) || re.test(file)) return { role, reason: `file name ${base}` };
    for (const [re, role] of PATH_ROLES) {
      const m = re.exec(file);
      if (m) return { role, reason: `lives in ${m[0].replace(/^\//, '')}` };
    }
    return undefined;
  };

  for (const s of symbols.values()) {
    s.role = undefined;
    s.roleReason = undefined;
  }
  const classes = new Map<string, { role: Role; reason: string }>();
  for (const s of symbols.values()) {
    if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct' || s.kind === 'enum') {
      const testPath = pathRole(s.file);
      const r = testPath?.role === 'test' ? testPath : classRole(s) ?? testPath;
      s.role = r?.role ?? 'other';
      s.roleReason = r?.reason;
      classes.set(s.id, { role: s.role, reason: s.roleReason ?? '' });
    }
  }
  for (const s of symbols.values()) {
    if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct' || s.kind === 'enum') continue;
    if (s.name === 'main' && s.kind === 'function') {
      s.role = 'entry';
      s.roleReason = 'program entry point';
      continue;
    }
    const testPath = pathRole(s.file);
    if (testPath?.role === 'test') {
      s.role = 'test';
      s.roleReason = testPath.reason;
      continue;
    }
    const cls = s.containerId ? classes.get(s.containerId) : undefined;
    if (cls && cls.role !== 'other') {
      s.role = cls.role;
      s.roleReason = `member of ${s.container} (${cls.reason})`;
      continue;
    }
    // Annotations directly on functions (Python decorators, TS decorators)
    for (const a of s.annotations) {
      if (/\.(get|post|put|patch|delete|route|api_route|websocket)$|^(app|router|bp|blueprint)\./i.test(a.name)) {
        s.role = 'controller';
        s.roleReason = `@${a.name} decorator`;
        break;
      }
    }
    if (s.role) continue;
    const byName = NAME_ROLES.find(([re]) => re.test(capitalize(s.name)));
    const pr = pathRole(s.file);
    const r = pr ?? (byName ? { role: byName[1], reason: `name "${s.name}"` } : undefined);
    s.role = r?.role ?? 'other';
    s.roleReason = r?.reason;
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Apply the user's role corrections. Later rules win. A rule on a class also applies to its members.
 *  - `src/legacy/**` (contains / or *): every symbol in matching files
 *  - `OrderService`: that class (and its methods) or that function
 *  - `OrderService.place`: one method
 */
export function applyRoleOverrides(symbols: Map<string, CodeSymbol>, overrides: ProjectSettings['roleOverrides']) {
  if (!overrides.length) return;
  for (const o of overrides) {
    const isPath = /[/*]/.test(o.match);
    const glob = isPath ? ignore().add(o.match) : null;
    for (const s of symbols.values()) {
      const full = s.container ? `${s.container}.${s.name}` : s.name;
      const hit = glob ? glob.ignores(s.file) : full === o.match || s.name === o.match && !s.container || s.container === o.match;
      if (hit) {
        s.role = o.role;
        s.roleReason = `set by you (${o.match})`;
      }
    }
  }
}
