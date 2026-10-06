// Monaco is loaded piece by piece: the editor core, the contributions a read-only viewer needs,
// and syntax highlighting for the languages we analyze. No language servers are loaded.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/features/find/register';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
// The package exports map does not expose CSS files, so import the codicon font styles by path.
import '../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/html/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme('ub-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6c7486', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b4a0ff' },
    { token: 'string', foreground: '9ad9a6' },
    { token: 'number', foreground: 'f5b86b' },
    { token: 'type', foreground: '6cc7f0' },
    { token: 'annotation', foreground: 'f5c95a' },
  ],
  colors: {
    'editor.background': '#0d0f14',
    'editor.foreground': '#dfe3ec',
    'editorLineNumber.foreground': '#3c4354',
    'editorLineNumber.activeForeground': '#8b93a5',
    'editor.lineHighlightBackground': '#151924',
    'editor.selectionBackground': '#2e3550',
    'editorGutter.background': '#0d0f14',
    'editorWidget.background': '#151821',
    'editorHoverWidget.background': '#151821',
    'editorHoverWidget.border': '#303747',
    'scrollbarSlider.background': '#30374766',
    'minimap.background': '#0d0f14',
    'editorStickyScroll.background': '#11141b',
    'editorStickyScrollHover.background': '#1a1e29',
  },
});

monaco.editor.defineTheme('ub-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a92a3', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6d28d9' },
    { token: 'string', foreground: '15803d' },
    { token: 'number', foreground: 'b45309' },
    { token: 'type', foreground: '0369a1' },
    { token: 'annotation', foreground: 'a16207' },
  ],
  colors: {
    // Matches the soft-gray light theme rather than glaring white.
    'editor.background': '#f3f4f6',
    'editor.foreground': '#1f2430',
    'editorLineNumber.foreground': '#a9b0bc',
    'editorLineNumber.activeForeground': '#4d5567',
    'editor.lineHighlightBackground': '#e9ebef',
    'editor.selectionBackground': '#c9cff7',
    'editorGutter.background': '#f3f4f6',
    'minimap.background': '#eef0f3',
    'editorWidget.background': '#f3f4f6',
    'editorHoverWidget.background': '#f6f7f9',
    'editorHoverWidget.border': '#c9ced7',
    'editorStickyScroll.background': '#eceef2',
  },
});

export const MONACO_LANG: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'typescript',
  java: 'java',
  python: 'python',
  c: 'cpp',
  cpp: 'cpp',
  go: 'go',
  rust: 'rust',
  csharp: 'csharp',
};

export function languageForPath(path: string, lang: string | null): string {
  if (/\.(vue|svelte)$/.test(path)) return 'html';
  if (lang) return MONACO_LANG[lang] ?? 'plaintext';
  if (path.endsWith('.sql')) return 'sql';
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.(xml|csproj)$/.test(path) || path.endsWith('pom.xml')) return 'xml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

export { monaco };
