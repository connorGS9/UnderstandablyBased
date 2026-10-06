/// <reference types="vite/client" />
declare module 'monaco-editor/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/*';
