// All pixel-crunching (DEM decode, slope, winter filter) runs here, off the UI thread.
import { elevationAt, slopeAt } from './dem';
import { imageryProtocol } from './imagery';
import { slopeProtocol } from './slope';

type Req = { id: number; op: string; args: any[] } | { id: number; op: 'cancel' };

const inflight = new Map<number, AbortController>();

type Done = { result: unknown; transfer: Transferable[]; after?: () => Promise<void> };

async function run(op: string, args: any[], abort: AbortController): Promise<Done> {
  switch (op) {
    case 'imagery': {
      const { data, canvas } = await imageryProtocol({ url: args[0] }, abort);
      // After delivering the tile, send a compressed copy for the page's cache, so looking back at
      // an area that left the screen doesn't redo the download and the winter filter.
      const after = async () => {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        (self as unknown as Worker).postMessage({ cache: { key: args[0], blob } });
      };
      return { result: data, transfer: [data], after };
    }
    case 'slope': {
      const { data } = await slopeProtocol({ url: args[0] });
      return { result: data, transfer: [data] };
    }
    case 'elevations': {
      const pts = args[0] as [number, number][];
      return { result: await Promise.all(pts.map(([lng, lat]) => elevationAt(lng, lat))), transfer: [] };
    }
    case 'terrainAlong': {
      const pts = args[0] as [number, number][];
      return { result: await Promise.all(pts.map(([lng, lat]) => slopeAt(lng, lat))), transfer: [] };
    }
    case 'pointInfo':
      return { result: await slopeAt(args[0], args[1]), transfer: [] };
  }
  throw new Error(`Unknown op ${op}`);
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  if (msg.op === 'cancel') {
    inflight.get(msg.id)?.abort();
    return;
  }
  const abort = new AbortController();
  inflight.set(msg.id, abort);
  try {
    const { result, transfer, after } = await run(msg.op, (msg as { args: any[] }).args, abort);
    (self as unknown as Worker).postMessage({ id: msg.id, result }, transfer);
    await after?.().catch(() => {});
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: msg.id, error: (e as Error).message ?? String(e) });
  } finally {
    inflight.delete(msg.id);
  }
};
