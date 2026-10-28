// All pixel-crunching (DEM decode, slope, winter filter) runs here, off the UI thread.
import { demTileAsTerrarium, elevationAt, slopeAt } from './dem';
import { imageryProtocol } from './imagery';
import { slopeProtocol } from './slope';

type Req = { id: number; op: string; args: any[] } | { id: number; op: 'cancel' };

const inflight = new Map<number, AbortController>();

async function run(op: string, args: any[], abort: AbortController): Promise<{ result: unknown; transfer: Transferable[] }> {
  switch (op) {
    case 'imagery': {
      const { data } = await imageryProtocol({ url: args[0] }, abort);
      return { result: data, transfer: [data] };
    }
    case 'slope': {
      const { data } = await slopeProtocol({ url: args[0] });
      return { result: data, transfer: [data] };
    }
    case 'dem': {
      const bmp = await demTileAsTerrarium(args[0], args[1], args[2]);
      if (!bmp) throw new Error('No DEM');
      return { result: bmp, transfer: [bmp] };
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
    const { result, transfer } = await run(msg.op, (msg as { args: any[] }).args, abort);
    (self as unknown as Worker).postMessage({ id: msg.id, result }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: msg.id, error: (e as Error).message ?? String(e) });
  } finally {
    inflight.delete(msg.id);
  }
};
