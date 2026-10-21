export type ControlStatus = {
  allowControl: boolean;
  hostConnected: boolean;
  state: string;
  canWrite: boolean;
  controllerViewerId?: string | null;
  pendingControlRequest?: unknown;
  hasPendingControlRequest?: boolean;
};

// Input defaults on for permitted links. Lock is local intent, so reconnects
// must not undo it; the relay remains authoritative about who can write.
export class InputControl {
  locked = false;
  status: ControlStatus | null = null;
  private requested = false;
  private releasing = false;
  private send: (type: string) => void;

  constructor(send: (type: string) => void) { this.send = send; }

  get writable() {
    const s = this.status;
    return Boolean(!this.locked && !this.releasing && s?.allowControl &&
      s.hostConnected && s.state === 'active' && s.canWrite);
  }

  reset() {
    this.status = null;
    this.requested = this.releasing = false;
  }

  update(status: ControlStatus) {
    this.status = status;
    if (!status.canWrite) this.releasing = false;
    if (status.canWrite || !status.hostConnected || !status.allowControl ||
      (status.controllerViewerId && !status.canWrite) ||
      (status.hasPendingControlRequest && !status.pendingControlRequest)) this.requested = false;
    this.sync();
  }

  toggle() {
    if (!this.status?.allowControl || ['ended', 'closed'].includes(this.status.state)) return;
    this.locked = !this.locked;
    this.requested = false;
    this.sync();
  }

  private sync() {
    const s = this.status;
    if (!s?.allowControl || !s.hostConnected || s.state !== 'active') return;
    if (this.locked) {
      // A grant may arrive after Lock was clicked. Never enable input for it.
      if (s.canWrite && !this.releasing) {
        this.releasing = true;
        this.send('control.release');
      }
    } else if (!s.canWrite && !s.controllerViewerId && !s.hasPendingControlRequest &&
      !s.pendingControlRequest && !this.requested) {
      // One request per opportunity, not on every status/resize update. A host
      // rejection must not start an automatic request/rejection loop.
      this.requested = true;
      this.send('control.request');
    }
  }
}
