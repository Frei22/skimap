// Main-thread side of the tile workers: a tiny promise RPC with cancellation.
// Elevation work gets its own worker so 3D terrain never waits behind imagery processing;
// imagery/slope tiles are spread over a small pool, routed by area so each worker's DEM cache stays warm.
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

function spawn() {
  const worker = new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  worker.onmessage = (ev: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.error !== undefined) p.reject(new Error(ev.data.error));
    else p.resolve(ev.data.result);
  };
  return { worker, pending };
}

const demWorker = spawn();
const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
const pool = Array.from({ length: poolSize }, spawn);
let nextId = 1;

const DEM_OPS = new Set(['dem', 'elevations', 'pointInfo']);

/** `area` (e.g. a z10 ancestor tile key) keeps neighbouring tiles on the same worker. */
export function call<T>(op: string, args: unknown[], signal?: AbortSignal, area?: string): Promise<T> {
  let w = demWorker;
  if (!DEM_OPS.has(op)) {
    let h = 0;
    for (const c of area ?? '') h = (h * 31 + c.charCodeAt(0)) | 0;
    w = pool[Math.abs(h) % pool.length];
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    w.pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => {
      if (!w.pending.has(id)) return;
      w.pending.delete(id);
      w.worker.postMessage({ id, op: 'cancel' });
      reject(new DOMException('Aborted', 'AbortError'));
    });
    w.worker.postMessage({ id, op, args });
  });
}

/** Key of the zoom-10 (or coarser) ancestor of a tile URL like proto://z/x/y. */
export function areaKey(url: string) {
  const m = /:\/\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  if (!m) return '';
  const z = +m[1], k = 2 ** Math.max(0, z - 10);
  return `${Math.floor(+m[2] / k)}/${Math.floor(+m[3] / k)}`;
}
