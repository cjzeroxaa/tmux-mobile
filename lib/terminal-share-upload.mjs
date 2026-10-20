import { PassThrough } from 'node:stream';

// Reuse the normal attachment writer, including its safe name, private temp
// directory and partial-file cleanup. Only one acknowledged chunk is in flight.
export class TerminalShareUpload {
  constructor(backend) { this.backend = backend; this.current = null; this.cleanup = Promise.resolve(); this.generation = 0; }
  cancel() {
    this.generation++;
    const current = this.current;
    this.current = null;
    if (!current) return this.cleanup;
    clearTimeout(current.timer);
    current.stream.destroy(Error('Upload cancelled'));
    this.cleanup = current.saved.catch(() => {});
    return this.cleanup;
  }
  async handle(type, payload) {
    if (type === 'upload.cancel') { this.cancel(); return {}; }
    if (type === 'upload.start') {
      if (!Number.isSafeInteger(payload.size) || payload.size < 0) throw Error('Invalid file size');
      const cleanup = this.cancel();
      const generation = this.generation;
      await cleanup;
      if (generation !== this.generation) throw Error('Upload cancelled');
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      // The writer can fail before the first chunk (for example disk full).
      stream.on('error', () => {});
      const current = { id: payload.id, size: payload.size, received: 0, stream };
      this.current = current;
      current.saved = this.backend.writeTempFile(payload.name, stream).catch(error => {
        current.error = error;
        stream.destroy(error);
        throw error;
      });
      current.saved.catch(() => {});
    }
    const current = this.current;
    if (!current || current.id !== payload.id) throw Error('Upload is no longer active');
    if (current.error) throw current.error;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => this.cancel(), 60_000);
    current.timer.unref?.();
    if (type === 'upload.chunk') {
      if (typeof payload.data !== 'string' || payload.data.length > 90_000) throw Error('Invalid upload chunk');
      const bytes = Buffer.from(payload.data, 'base64');
      if (payload.offset !== current.received || current.received + bytes.length > current.size) throw Error('Invalid upload offset');
      await new Promise((resolve, reject) => current.stream.write(bytes, error => error ? reject(error) : resolve()));
      current.received += bytes.length;
    }
    if (type === 'upload.end') {
      if (current.received !== current.size) throw Error('Incomplete upload');
      current.stream.end();
      const result = await current.saved;
      clearTimeout(current.timer);
      if (this.current === current) this.current = null;
      return result;
    }
    return { received: current.received };
  }
}
