// Off-main-thread waveform peak extraction.
//
// computePeaks() shells out to `wvunpack` and then walks every sample of a
// take file (up to ~30 min x N channels) — seconds of CPU + blocking I/O that
// would otherwise freeze the server's event loop (WebSocket backpressure,
// missed PTP health polls, delayed mixer sync). The main thread posts a source
// path here and gets back a PeaksFile (or null). The on-disk <name>.peaks.json
// cache inside ensurePeaks() still means this runs at most once per take file.

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { ensurePeaks, type PeaksFile } from './wavPeaks';

if (!parentPort) {
  throw new Error('wavPeaksWorker must be run as a worker thread');
}

parentPort.on('message', (srcPath: string) => {
  let peaks: PeaksFile | null = null;
  try {
    if (fs.existsSync(srcPath)) peaks = ensurePeaks(srcPath);
  } catch (e) {
    console.error('wavPeaksWorker: failed for', srcPath, e);
  }
  parentPort!.postMessage(peaks);
});
