import { parentPort } from 'node:worker_threads';
import { handle } from './engine-host';

// Engine work (parsing thousands of files) happens off the main process so the window never freezes.
parentPort!.on('message', async (msg: { id: number; method: any; params: any }) => {
  try {
    const result = await handle(msg.method, msg.params, (progress) => parentPort!.postMessage({ type: 'progress', progress }));
    parentPort!.postMessage({ type: 'result', id: msg.id, result });
  } catch (e) {
    parentPort!.postMessage({ type: 'error', id: msg.id, error: (e as Error).message ?? String(e) });
  }
});
