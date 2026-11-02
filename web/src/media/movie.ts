/**
 * WebM capture of a canvas with MediaRecorder, and saving results.
 *
 * MediaRecorder samples the canvas in real time, so a movie of N frames at
 * F fps takes N / F seconds to record. VP9 when the browser has it.
 */

function webmType(): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not available in this browser.');
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
}

/** Encodes `frames` frames, each drawn by `draw(frame)`, into a WebM blob. */
export async function encodeCanvasMovie(
  canvas: HTMLCanvasElement,
  draw: (frame: number) => void,
  opts: { frames: number; fps?: number; bitsPerSecond?: number },
): Promise<Blob> {
  const fps = opts.fps ?? 30;
  draw(0);
  const recorder = new MediaRecorder(canvas.captureStream(fps), { mimeType: webmType(), videoBitsPerSecond: opts.bitsPerSecond ?? 6e6 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  for (let f = 0; f < opts.frames; f++) {
    draw(f);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: 'video/webm' });
}

/** Records whatever a live canvas shows for `durationMs`, for example one animation period. */
export async function recordCanvas(canvas: HTMLCanvasElement, durationMs: number, fps = 30): Promise<Blob> {
  const recorder = new MediaRecorder(canvas.captureStream(fps), { mimeType: webmType() });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  await new Promise((r) => setTimeout(r, durationMs));
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: 'video/webm' });
}

/** Hands `blob` to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
