/**
 * The icon vocabulary a plugin may name in `contributes.views[].icon`.
 *
 * Why a curated set rather than "any lucide icon":
 *
 * `@lucide/vue` exports **6330** icons (16MB of source). The shadcn components
 * import the handful they need, so tree-shaking keeps the bundle at ~1.6MB. A
 * lookup-by-name over the whole module would defeat that and roughly double it —
 * to serve a sidebar glyph.
 *
 * So: a fixed vocabulary, imported by name so the bundler can see them. A plugin
 * that needs something not here uses an emoji, which always worked.
 *
 * Adding an icon here is cheap — one import and one map entry.
 *
 * Naming: kebab-case, matching lucide's own names, so a plugin author who knows
 * lucide already knows the vocabulary.
 */
import {
  Activity,
  AlarmClock,
  AppWindow,
  Bell,
  Book,
  Bug,
  Calculator,
  Calendar,
  ChartLine,
  Check,
  CircleHelp,
  Clock,
  Code,
  Code2,
  Cpu,
  Crop,
  Database,
  Download,
  Eye,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Hammer,
  Image,
  Key,
  Layers,
  Link,
  List,
  Lock,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  Package,
  Palette,
  Play,
  Plug,
  Plus,
  Puzzle,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  ShoppingBag,
  Star,
  StickyNote,
  Sun,
  Terminal,
  Timer,
  Trash,
  Upload,
  Users,
  Wand,
  Wrench,
  Zap,
} from '@lucide/vue';

/** kebab-case name → component. Keys are what a plugin writes in plugin.json. */
const ICONS = {
  activity: Activity,
  'alarm-clock': AlarmClock,
  'app-window': AppWindow,
  bell: Bell,
  book: Book,
  bug: Bug,
  calculator: Calculator,
  calendar: Calendar,
  'chart-line': ChartLine,
  check: Check,
  clock: Clock,
  code: Code,
  'code-2': Code2,
  cpu: Cpu,
  crop: Crop,
  database: Database,
  download: Download,
  eye: Eye,
  'file-text': FileText,
  folder: Folder,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  hammer: Hammer,
  'circle-help': CircleHelp,
  image: Image,
  key: Key,
  layers: Layers,
  link: Link,
  list: List,
  lock: Lock,
  mail: Mail,
  'message-square': MessageSquare,
  monitor: Monitor,
  moon: Moon,
  network: Network,
  package: Package,
  palette: Palette,
  play: Play,
  plug: Plug,
  plus: Plus,
  puzzle: Puzzle,
  rocket: Rocket,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  'shopping-bag': ShoppingBag,
  star: Star,
  'sticky-note': StickyNote,
  sun: Sun,
  terminal: Terminal,
  timer: Timer,
  trash: Trash,
  upload: Upload,
  users: Users,
  wand: Wand,
  wrench: Wrench,
  zap: Zap,
};

/** Every name a plugin may use. Exposed so the diagnostics view can list them. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Resolve a `contributes.views[].icon` value.
 *
 *   "lucide:file-text"  → the named icon (see the vocabulary above)
 *   anything else       → null, meaning "render this as text" — which is how
 *                         emoji keep working, and how an unknown name degrades
 *                         instead of leaving a hole in the sidebar
 *
 * One branch at the call site: `icon ? <component :is="icon" /> : <span>{{ raw }}</span>`.
 */
export function resolveIcon(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();

  if (value.startsWith('lucide:')) {
    const name = value.slice('lucide:'.length).trim().toLowerCase();
    const found = ICONS[name];
    if (!found) {
      // A typo must not put the literal string "lucide:file-txt" in the sidebar —
      // that reads as a bug in the plugin. Fall back to a generic glyph, and
      // say so in the console where the author will look.
      console.warn(
        `[icons] unknown icon "${name}" — falling back to "puzzle". Known names: ${ICON_NAMES.join(', ')}`,
      );
      return ICONS.puzzle;
    }
    return found;
  }

  return null;
}
