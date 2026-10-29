// Main-thread side of the tile workers: a tiny promise RPC with cancellation and a scheduler.
// Point queries (taps, profiles) get their own worker so they never wait behind imagery processing.
// Imagery/slope tiles share one queue, coarsest zoom first, a few jobs per worker at a time: the few
// low-zoom tiles that cover the whole view finish first and the detail fills in, instead of every tile
// downloading at once and all of them arriving late together.
type Job = {
  id: number;
  op: string;
  args: unknown[];
  priority: number;
  area: string;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  worker?: Slot;
};
type Slot = { worker: Worker; jobs: Map<number, Job> };

function spawn(): Slot {
  const slot: Slot = { worker: new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' }), jobs: new Map() };
  slot.worker.onmessage = (ev: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const job = slot.jobs.get(ev.data.id);
    if (!job) return;
    slot.jobs.delete(job.id);
    if (ev.data.error !== undefined) job.reject(new Error(ev.data.error));
    else job.resolve(ev.data.result);
    pump();
  };
  return slot;
}

const demWorker = spawn();
const poolSize = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
const pool = Array.from({ length: poolSize }, spawn);
/** Jobs per worker at once: enough to overlap network waits, few enough not to flood the connection. */
const PER_WORKER = 3;
const queue: Job[] = [];
let nextId = 1;

const DEM_OPS = new Set(['elevations', 'pointInfo', 'terrainAlong']);

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function start(job: Job, slot: Slot) {
  job.worker = slot;
  slot.jobs.set(job.id, job);
  slot.worker.postMessage({ id: job.id, op: job.op, args: job.args });
}

function pump() {
  while (queue.length) {
    const free = pool.filter((s) => s.jobs.size < PER_WORKER);
    if (!free.length) return;
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i;
    const job = queue.splice(best, 1)[0];
    // Prefer the worker that holds this area's elevation in its cache, else any free one.
    const home = pool[hash(job.area) % pool.length];
    start(job, free.includes(home) ? home : free.reduce((a, b) => (a.jobs.size <= b.jobs.size ? a : b)));
  }
}

/** `area` keeps neighbouring tiles on the same worker when it's free; `priority`: lower runs first. */
export function call<T>(op: string, args: unknown[], signal?: AbortSignal, area = '', priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: Job = { id: nextId++, op, args, priority, area, resolve, reject };
    signal?.addEventListener('abort', () => {
      const queued = queue.indexOf(job);
      if (queued >= 0) queue.splice(queued, 1);
      else if (job.worker?.jobs.delete(job.id)) {
        job.worker.worker.postMessage({ id: job.id, op: 'cancel' });
        pump();
      } else return;
      reject(new DOMException('Aborted', 'AbortError'));
    });
    if (DEM_OPS.has(op)) start(job, demWorker);
    else {
      queue.push(job);
      pump();
    }
  });
}

/** Zoom of a tile URL like proto://z/x/y. */
export const tileZoom = (url: string) => Number(/:\/\/(\d+)\//.exec(url)?.[1] ?? 0);

/** Key of the zoom-12 (or coarser) ancestor of a tile URL like proto://z/x/y. */
export function areaKey(url: string) {
  const m = /:\/\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  if (!m) return '';
  const z = +m[1], k = 2 ** Math.max(0, z - 12);
  return `${Math.floor(+m[2] / k)}/${Math.floor(+m[3] / k)}`;
}
