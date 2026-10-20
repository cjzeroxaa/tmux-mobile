// Adapted from jiayx/shello at 17366a2. See README.md for provenance.
import { DurableObject } from "cloudflare:workers";
import {
  BinaryMessageType,
  binaryMessageType,
  binarySocketDataToArrayBuffer,
} from "./protocol";

type SessionState = "idle" | "ready" | "active" | "ended" | "closed";
type SessionRole = "host" | "viewer";
type HostState = "waiting" | "online" | "reconnecting" | "offline";
type ViewerInfo = {
  id: string;
  token: string;
  socket: WebSocket;
};
type ControlRequest = {
  viewerId: string;
  leaseSeconds: number;
};
type TerminalSize = {
  cols: number;
  rows: number;
};
type TerminalProfile = {
  platform: "unix" | "windows";
  pty?: "conpty";
};
type SessionRecord = {
  allowControl?: boolean;
  state: SessionState;
  currentControllerId: string | null;
  controlLeaseExpiresAt: number | null;
  pendingRequest: ControlRequest | null;
  pendingRequestExpiresAt: number | null;
  viewerIdentities: Record<string, string>;
  createdAt: number;
  maxExpiresAt: number;
  sessionExpiresAt: number;
  hostDisconnectDeadline: number | null;
  endReason: string | null;
  generation: number;
};
type SocketAttachment =
  | {
      role: "host";
    }
  | {
      role: "viewer";
      viewerId: string;
      viewerToken: string;
      snapshotRequestId: string;
      lines?: number;
    };
type Env = Record<string, unknown>;

const DEFAULT_CONTROL_LEASE_SECONDS = 30 * 60;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_THRESHOLD_MS = 30 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 3 * 60 * 1000;
const PENDING_REQUEST_TIMEOUT_MS = 30 * 1000;
const SESSION_RECORD_KEY = "session";

function createInitialSessionRecord(state: SessionState = "idle"): SessionRecord {
  const createdAt = Date.now();
  return {
    state,
    currentControllerId: null,
    controlLeaseExpiresAt: null,
    pendingRequest: null,
    pendingRequestExpiresAt: null,
    viewerIdentities: {},
    createdAt,
    maxExpiresAt: createdAt + SESSION_IDLE_TTL_MS,
    sessionExpiresAt: Math.min(createdAt + SESSION_IDLE_TTL_MS, createdAt + SESSION_MAX_TTL_MS),
    hostDisconnectDeadline: null,
    endReason: null,
    generation: 0,
  };
}

export class TTYSession extends DurableObject {
  private host: WebSocket | null = null;
  private viewers = new Map<WebSocket, ViewerInfo>();
  private hostConnected = false;
  private hostTerminalSize: TerminalSize | null = null;
  private hostTerminalProfile: TerminalProfile | null = null;
  private record: SessionRecord = createInitialSessionRecord();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.restoreSessionRecord();
      if (this.restoreSockets()) {
        await this.persistRecord();
        await this.scheduleNextAlarm();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.record.state !== "idle" && this.record.state !== "closed") {
        return new Response("session id already exists", { status: 409 });
      }
      const options = await request.json() as { allowControl?: boolean; expiresAt?: number };
      const expiresAt = options.expiresAt ?? Date.now() + SESSION_IDLE_TTL_MS;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + SESSION_MAX_TTL_MS) {
        return new Response("Invalid expiry", { status: 400 });
      }
      this.record = createInitialSessionRecord("ready");
      this.record.allowControl = options.allowControl === true;
      this.record.maxExpiresAt = this.record.sessionExpiresAt = expiresAt;
      await this.persistRecord();
      await this.scheduleNextAlarm();
      return Response.json(this.snapshot());
    }

    if (url.pathname === "/end" && request.method === "POST") {
      this.endSharing("owner stopped sharing");
      await this.persistRecord();
      this.finishSharing();
      await this.scheduleNextAlarm();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      await this.advanceRecordAndPersist();
      return Response.json(this.snapshotForViewerToken(url.searchParams.get("viewerToken")));
    }

    if (url.pathname === "/connect/host") {
      return this.acceptSocket("host", request);
    }

    if (url.pathname === "/connect/viewer") {
      return this.acceptSocket("viewer", request);
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const changed = await this.advanceRecordAndPersist();
    if (changed) {
      this.broadcastStatus();
    }
    await this.scheduleNextAlarm();
  }

  private async acceptSocket(role: SessionRole, request: Request): Promise<Response> {
    await this.advanceRecordAndPersist();
    if (this.record.state === "closed" || this.record.state === "ended" || this.record.state === "idle") {
      return new Response("session ended", { status: 410 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.touchSession();

    if (role === "host") {
      this.host?.close(4001, "replaced by new host");
      server.serializeAttachment({ role });
      this.ctx.acceptWebSocket(server, [role]);
      this.host = server;
      this.hostConnected = true;
      this.hostTerminalSize = null;
      this.hostTerminalProfile = null;
      await this.updateRecord((record) => {
        record.hostDisconnectDeadline = null;
        record.endReason = null;
        record.generation += 1;
        record.currentControllerId = null;
        record.controlLeaseExpiresAt = null;
        record.pendingRequest = null;
        record.pendingRequestExpiresAt = null;
        record.state = "active";
      });
    } else {
      const viewerIdentity = await this.resolveViewerIdentity(request);
      server.serializeAttachment({
        role,
        viewerId: viewerIdentity.id,
        viewerToken: viewerIdentity.token,
        snapshotRequestId: crypto.randomUUID(),
        lines: this.historyLines(new URL(request.url).searchParams.get('lines')),
      });
      this.ctx.acceptWebSocket(server, [role]);
      const viewer = {
        id: viewerIdentity.id,
        token: viewerIdentity.token,
        socket: server,
      };
      this.viewers.set(server, viewer);
      this.replaceViewerConnection(viewer, "replaced by newer viewer");
    }

    this.sendSocket(
      server,
      JSON.stringify({
        type: "session.status",
        payload: this.snapshot(server, role),
      }),
    );
    if (role === "host") {
      this.requestHostTerminalDetails();
    } else if (role === "viewer" && (!this.hostTerminalSize || !this.hostTerminalProfile)) {
      this.requestHostTerminalDetails();
    }
    for (const target of role === "host" ? this.viewers.keys() : [server]) {
      const attachment = target.deserializeAttachment() as SocketAttachment;
      if (attachment.role === "viewer") {
        this.sendHost(JSON.stringify({
          type: "terminal.snapshot.request",
          payload: { requestId: attachment.snapshotRequestId, lines: attachment.lines ?? 500 },
        }));
      }
    }
    this.broadcastStatus();
    void this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(1003, "missing socket attachment");
      return;
    }

    await this.handleMessage(attachment.role, socket, data);
  }

  async webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      return;
    }

    await this.handleClose(attachment.role, socket);
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket);
  }

  private restoreSockets() {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) {
        socket.close(1003, "missing socket attachment");
        continue;
      }

      if (attachment.role === "host") {
        if (this.host && this.host !== socket) {
          socket.close(4001, "replaced by newer host");
          continue;
        }
        this.host = socket;
        this.hostConnected = true;
        continue;
      }

      const viewer = {
        id: attachment.viewerId,
        token: attachment.viewerToken,
        socket,
      };
      this.viewers.set(socket, viewer);
      this.replaceViewerConnection(viewer, "replaced by newer viewer");
    }

    if (this.record.state === "closed") {
      this.finishClosedSession();
      return false;
    }
    if (this.record.state === "ended") {
      this.finishSharing();
      return false;
    }
    if (this.hostConnected && (!this.hostTerminalSize || !this.hostTerminalProfile)) {
      this.requestHostTerminalDetails();
    }
    return this.reconcileRecordWithSockets();
  }

  private reconcileRecordWithSockets() {
    if (this.hostConnected) {
      const changed =
        this.record.hostDisconnectDeadline !== null || this.record.state !== "active";
      this.record.hostDisconnectDeadline = null;
      this.record.state = "active";
      return changed;
    }

    if (this.viewers.size > 0 && this.record.state === "idle") {
      this.record.state = "ready";
      return true;
    }

    if (this.record.state === "active") {
      this.record.hostDisconnectDeadline ??= Date.now() + HOST_DISCONNECT_GRACE_MS;
      this.record.currentControllerId = null;
      this.record.controlLeaseExpiresAt = null;
      this.record.pendingRequest = null;
      this.record.pendingRequestExpiresAt = null;
      this.record.state = "ready";
      return true;
    }

    return false;
  }

  private async restoreSessionRecord() {
    const record = await this.ctx.storage.get<SessionRecord>(SESSION_RECORD_KEY);
    if (!record) {
      return;
    }

    this.record = record;
  }

  private async resolveViewerIdentity(request: Request) {
    const token = validViewerToken(new URL(request.url).searchParams.get("viewerToken"));
    if (token) {
      const existingViewerId = this.record.viewerIdentities[token];
      if (existingViewerId) {
        return { id: existingViewerId, token };
      }
    }

    const viewerToken = randomViewerToken();
    const viewerId = crypto.randomUUID().slice(0, 8);
    await this.updateRecord((record) => {
      record.viewerIdentities[viewerToken] = viewerId;
    });
    return { id: viewerId, token: viewerToken };
  }

  private async persistRecord() {
    const record = structuredClone(this.record);
    const write = this.persistQueue.then(() => this.ctx.storage.put(SESSION_RECORD_KEY, record));
    this.persistQueue = write.catch(() => {});
    await write;
  }

  private async updateRecord(mutator: (record: SessionRecord) => void) {
    mutator(this.record);
    await this.persistRecord();
    await this.scheduleNextAlarm();
  }

  private async handleMessage(
    role: SessionRole,
    socket: WebSocket,
    data: unknown,
  ) {
    const advanced = await this.advanceRecordAndPersist();
    if (advanced) {
      this.broadcastStatus();
    }

    if (this.record.state === "closed") return;
    if (role === "host" && socket !== this.host) return;
    if (role === "viewer" && !this.viewers.has(socket)) return;

    if ((typeof data === "string" ? new TextEncoder().encode(data).length : (data as ArrayBuffer).byteLength) > (role === 'host' ? 16 : 1) * 1024 * 1024) {
      socket.close(1009, "message too large");
      return;
    }
    if (role === "host") {
      if (typeof data === "string") {
        const frame = parseEnvelope(data);
        if (frame?.type === 'terminal.refresh') {
          for (const viewer of this.viewers.values()) {
            const attachment = viewer.socket.deserializeAttachment() as SocketAttachment;
            if (attachment.role !== 'viewer') continue;
            attachment.snapshotRequestId = crypto.randomUUID();
            viewer.socket.serializeAttachment(attachment);
            this.sendHost(JSON.stringify({ type: 'terminal.snapshot.request', payload: { requestId: attachment.snapshotRequestId, lines: attachment.lines ?? 500 } }));
          }
          return;
        }
        if (frame?.type === "session.end") {
          this.endSharing("host ended");
          await this.persistRecord();
          this.sendSocket(socket, JSON.stringify({ type: "session.ended", payload: {} }));
          this.finishSharing();
          await this.scheduleNextAlarm();
          return;
        }
        if (frame?.type === "terminal.snapshot") {
          // Match the connection, not just the viewer identity: a reply for an
          // older connection must never overwrite a newer refresh.
          const payload = frame.payload as { requestId?: unknown } | null;
          if (typeof payload?.requestId !== "string") return;
          for (const viewer of this.viewers.values()) {
            const attachment = viewer.socket.deserializeAttachment() as SocketAttachment;
            if (attachment.role === "viewer" && attachment.snapshotRequestId === payload.requestId) {
              this.sendViewer(viewer, data);
              break;
            }
          }
          return;
        }
        if (frame?.type === "upload.result") {
          const payload = frame.payload as { viewerId?: string };
          for (const viewer of this.viewers.values()) {
            if (viewer.id === payload.viewerId && this.canWrite(viewer.socket)) this.sendViewer(viewer, data);
          }
          return;
        }
        if (frame?.type === "control.approve") {
          await this.handleControlApprove(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.reject") {
          await this.handleControlReject(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.revoke") {
          await this.handleControlRevoke();
          await this.touchSession();
          return;
        }
        if (frame?.type === "terminal.size") {
          this.handleHostTerminalSize(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "terminal.profile") {
          this.handleHostTerminalProfile(frame.payload);
          await this.touchSession();
          return;
        }
        return;
      }

      const buffer = await binarySocketDataToArrayBuffer(data);
      if (!buffer) {
        socket.close(1003, "unsupported binary message container");
        return;
      }

      if (binaryMessageType(buffer) !== BinaryMessageType.ttyOutput) {
        socket.close(1003, "invalid host binary message");
        return;
      }

      if (socket !== this.host || !this.hostConnected) return;
      void this.touchSession();

      for (const viewer of this.viewers.values()) {
        this.sendViewer(viewer, buffer);
      }
      return;
    }

    if (typeof data !== "string") {
      const buffer = await binarySocketDataToArrayBuffer(data);
      if (!buffer) {
        socket.close(1003, "unsupported binary message container");
        return;
      }

      if (binaryMessageType(buffer) !== BinaryMessageType.stdin) {
        socket.close(1003, "invalid viewer binary message");
        return;
      }

      if (this.canWrite(socket)) {
        void this.touchSession();
        this.sendHost(buffer);
      }
      return;
    }

    const frame = parseEnvelope(data);
    if (frame?.type && ['upload.start', 'upload.chunk', 'upload.end', 'upload.cancel'].includes(frame.type)) {
      const payload = frame.payload as Record<string, unknown> | null;
      if (!payload || typeof payload.requestId !== 'string' || payload.requestId.length > 100) return;
      if (!this.canWrite(socket)) {
        this.sendSocket(socket, JSON.stringify({ type: 'upload.result', payload: { requestId: payload.requestId, error: 'Take control before uploading' } }));
        return;
      }
      const viewer = this.viewers.get(socket)!;
      this.sendHost(JSON.stringify({ type: frame.type, payload: { ...payload, viewerId: viewer.id } }));
      return;
    }
    if (frame?.type === 'terminal.snapshot.request') {
      const attachment = socket.deserializeAttachment() as SocketAttachment;
      if (attachment.role !== 'viewer') return;
      attachment.snapshotRequestId = crypto.randomUUID();
      attachment.lines = this.historyLines((frame.payload as { lines?: unknown })?.lines);
      socket.serializeAttachment(attachment);
      this.sendHost(JSON.stringify({ type: frame.type, payload: { requestId: attachment.snapshotRequestId, lines: attachment.lines } }));
      return;
    }
    if (frame?.type === "control.release") {
      if (this.canWrite(socket)) {
        await this.handleControlRevoke();
      }
      return;
    }
    if (frame?.type === "control.request") {
      await this.handleControlRequest(socket, frame.payload);
      await this.touchSession();
      return;
    }
    if (frame?.type === "terminal.size.request") {
      this.sendHost(JSON.stringify({ type: "terminal.size.request", payload: null }));
      await this.touchSession();
      return;
    }
    if (frame?.type === "terminal.profile.request") {
      this.sendHost(JSON.stringify({ type: "terminal.profile.request", payload: null }));
      await this.touchSession();
      return;
    }
  }

  private async handleClose(role: SessionRole, socket: WebSocket) {
    if (role === "host") {
      if (this.host !== socket) {
        return;
      }

      await this.clearHost();
      await this.scheduleNextAlarm();
      return;
    }

    await this.removeViewer(socket);
    this.broadcastStatus();
    await this.scheduleNextAlarm();
  }

  private async clearHost() {
    this.host = null;
    this.hostConnected = false;
    this.hostTerminalSize = null;
    this.hostTerminalProfile = null;
    await this.updateRecord((record) => {
      record.currentControllerId = null;
      record.controlLeaseExpiresAt = null;
      record.pendingRequest = null;
      record.pendingRequestExpiresAt = null;
      record.hostDisconnectDeadline = Date.now() + HOST_DISCONNECT_GRACE_MS;
      record.state = "ready";
    });
    this.broadcastStatus();
  }

  private handleHostTerminalSize(payload: unknown) {
    const size = normalizeTerminalSize(payload);
    if (!size) {
      return;
    }

    if (
      this.hostTerminalSize?.cols === size.cols &&
      this.hostTerminalSize?.rows === size.rows
    ) {
      return;
    }

    this.hostTerminalSize = size;
    this.broadcastStatus();
  }

  private handleHostTerminalProfile(payload: unknown) {
    const profile = normalizeTerminalProfile(payload);
    if (!profile) {
      return;
    }

    if (
      this.hostTerminalProfile?.platform === profile.platform &&
      this.hostTerminalProfile?.pty === profile.pty
    ) {
      return;
    }

    this.hostTerminalProfile = profile;
    this.broadcastStatus();
  }

  private async handleControlRequest(socket: WebSocket, payload: unknown) {
    await this.advanceRecordAndPersist();
    const viewer = this.viewers.get(socket);
    if (
      !this.record.allowControl ||
      !viewer ||
      !this.hostConnected ||
      this.record.currentControllerId ||
      this.record.pendingRequest
    ) {
      this.broadcastStatus();
      return;
    }

    await this.updateRecord((record) => {
      record.pendingRequest = {
        viewerId: viewer.id,
        leaseSeconds: normalizeLeaseSeconds(payload),
      };
      record.pendingRequestExpiresAt = Date.now() + PENDING_REQUEST_TIMEOUT_MS;
    });

    this.sendHost(
      JSON.stringify({
        type: "control.request",
        payload: this.record.pendingRequest,
      }),
    );
    this.broadcastStatus();
  }

  private async handleControlApprove(payload: unknown) {
    if (!this.record.pendingRequest) {
      return;
    }

    const approved = payload as { viewerId?: string };
    if (approved.viewerId !== this.record.pendingRequest.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.currentControllerId = record.pendingRequest!.viewerId;
      record.controlLeaseExpiresAt =
        Date.now() + normalizeLeaseSeconds(payload, record.pendingRequest!.leaseSeconds) * 1000;
      record.pendingRequest = null;
      record.pendingRequestExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private async handleControlReject(payload: unknown) {
    if (!this.record.pendingRequest) {
      return;
    }

    const rejected = payload as { viewerId?: string };
    if (rejected.viewerId !== this.record.pendingRequest.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.pendingRequest = null;
      record.pendingRequestExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private async handleControlRevoke() {
    if (!this.record.currentControllerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.currentControllerId = null;
      record.controlLeaseExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private canWrite(socket: WebSocket) {
    const viewer = this.viewers.get(socket);
    return this.record.state === "active" && this.hostConnected && Boolean(viewer) && viewer?.id === this.record.currentControllerId;
  }

  private snapshot(socket?: WebSocket, role?: SessionRole) {
    const viewer = socket ? this.viewers.get(socket) : null;
    return this.snapshotForViewer(viewer ?? null, role ?? null);
  }

  private snapshotForViewerToken(viewerToken: string | null) {
    const token = validViewerToken(viewerToken);
    const viewerId = token ? this.record.viewerIdentities[token] : null;
    const viewer = token && viewerId ? { id: viewerId, token } : null;
    return this.snapshotForViewer(viewer, viewer ? "viewer" : null);
  }

  private historyLines(value: unknown): number {
    const lines = Number(value);
    return [100, 500, 1000, 2000, 5000].includes(lines) ? lines : 500;
  }

  private snapshotForViewer(
    viewer: Pick<ViewerInfo, "id" | "token"> | null,
    role: SessionRole | null,
  ) {
    let pendingControlRequest: ControlRequest | null = null;
    if (role === "host") {
      pendingControlRequest = this.record.pendingRequest;
    } else if (viewer?.id && this.record.pendingRequest?.viewerId === viewer.id) {
      pendingControlRequest = this.record.pendingRequest;
    }

    return {
      allowControl: Boolean(this.record.allowControl),
      role: role ?? null,
      state: this.record.state,
      endReason: this.record.endReason,
      generation: this.record.generation,
      hostState: this.hostState(),
      hostConnected: this.hostConnected,
      viewerCount: this.viewers.size,
      viewerId: viewer?.id ?? null,
      viewerToken: viewer?.token ?? null,
      canWrite: this.record.state === "active" && this.hostConnected && Boolean(viewer?.id) && viewer?.id === this.record.currentControllerId,
      controllerViewerId: this.record.currentControllerId,
      controlLeaseExpiresAt: this.record.controlLeaseExpiresAt,
      pendingControlRequest,
      hasPendingControlRequest: this.record.pendingRequest !== null,
      sessionExpiresAt: this.record.sessionExpiresAt,
      hostDisconnectDeadline: this.record.hostDisconnectDeadline,
      pendingRequestExpiresAt: this.record.pendingRequestExpiresAt,
      terminalSize: this.hostTerminalSize,
      terminalProfile: this.hostTerminalProfile,
    };
  }

  private hostState(): HostState {
    if (this.record.state === "closed" || this.record.state === "ended") {
      return "offline";
    }
    if (this.hostConnected) {
      return "online";
    }
    if (this.record.hostDisconnectDeadline) {
      return "reconnecting";
    }
    return "waiting";
  }

  private broadcastStatus() {
    if (this.host) {
      this.sendHost(
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(this.host, "host"),
        }),
      );
    }

    for (const viewer of this.viewers.values()) {
      this.sendViewer(
        viewer,
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(viewer.socket, "viewer"),
        }),
      );
    }
  }

  private sendHost(message: string | ArrayBuffer) {
    if (!this.host) {
      return false;
    }

    if (this.sendSocket(this.host, message)) {
      return true;
    }

    void this.clearHost();
    return false;
  }

  private requestHostTerminalDetails() {
    this.sendHost(JSON.stringify({ type: "terminal.profile.request", payload: null }));
    this.sendHost(JSON.stringify({ type: "terminal.size.request", payload: null }));
  }

  private sendViewer(viewer: ViewerInfo, message: string | ArrayBuffer) {
    if (this.sendSocket(viewer.socket, message)) {
      return true;
    }

    void this.removeViewer(viewer.socket);
    return false;
  }

  private replaceViewerConnection(nextViewer: ViewerInfo, reason: string) {
    for (const [socket, viewer] of this.viewers.entries()) {
      if (socket === nextViewer.socket || viewer.token !== nextViewer.token) {
        continue;
      }

      this.viewers.delete(socket);
      socket.close(4001, reason);
    }
  }

  private sendSocket(socket: WebSocket, message: string | ArrayBuffer) {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private async removeViewer(socket: WebSocket) {
    const viewer = this.viewers.get(socket);
    this.viewers.delete(socket);

    if (viewer?.id === this.record.currentControllerId) {
      await this.handleControlRevoke();
    }

    if (viewer?.id !== this.record.pendingRequest?.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      if (viewer?.id === record.pendingRequest?.viewerId) {
        record.pendingRequest = null;
        record.pendingRequestExpiresAt = null;
      }
    });
  }

  private advanceRecord() {
    const now = Date.now();
    let changed = false;

    if (this.record.sessionExpiresAt && now >= this.record.sessionExpiresAt) {
      this.closeSession("session expired");
      return true;
    }

    if (this.record.pendingRequestExpiresAt && now >= this.record.pendingRequestExpiresAt) {
      this.record.pendingRequest = null;
      this.record.pendingRequestExpiresAt = null;
      changed = true;
    }

    if (this.record.controlLeaseExpiresAt && now >= this.record.controlLeaseExpiresAt) {
      this.record.currentControllerId = null;
      this.record.controlLeaseExpiresAt = null;
      changed = true;
    }

    if (
      !this.hostConnected &&
      this.record.hostDisconnectDeadline &&
      now >= this.record.hostDisconnectDeadline
    ) {
      this.endSharing("host disconnected");
      return true;
    }

    if (this.record.state !== "closed" && this.record.state !== "ended") {
      if (this.hostConnected) {
        if (this.record.state !== "active") {
          this.record.state = "active";
          changed = true;
        }
      } else if (this.record.state !== "idle") {
        if (this.record.state !== "ready") {
          this.record.state = "ready";
          changed = true;
        }
      }
    }

    return changed;
  }

  private async advanceRecordAndPersist() {
    const changed = this.advanceRecord();
    if (changed) {
      await this.persistRecord();
      if (this.record.state === "closed") this.finishClosedSession();
      else if (this.record.state === "ended") this.finishSharing();
    }
    return changed;
  }

  private endSharing(reason: string) {
    this.closeSession(reason);
    this.record.state = "ended";
  }

  private finishSharing() {
    this.hostConnected = false;
    this.hostTerminalSize = null;
    this.hostTerminalProfile = null;
    this.broadcastStatus();
    this.host?.close(4000, this.record.endReason ?? "sharing ended");
    this.host = null;
    // Viewers keep watching the pairing code and receive the next host's status.
  }

  private closeSession(reason: string) {
    if (this.record.state === "closed") {
      return;
    }

    this.hostConnected = false;
    this.record.state = "closed";
    this.record.endReason = reason;
    this.record.hostDisconnectDeadline = null;
    this.record.pendingRequest = null;
    this.record.pendingRequestExpiresAt = null;
    this.record.currentControllerId = null;
    this.record.controlLeaseExpiresAt = null;

  }

  private finishClosedSession() {
    this.hostConnected = false;
    this.broadcastStatus();
    const reason = this.record.endReason ?? "session ended";
    this.host?.close(4000, reason);
    this.host = null;
    for (const viewer of this.viewers.values()) viewer.socket.close(4000, reason);
    this.viewers.clear();
    this.hostTerminalSize = null;
    this.hostTerminalProfile = null;
  }

  private async touchSession() {
    if (this.record.state === "closed") return;

    const now = Date.now();
    const remaining = this.record.sessionExpiresAt - now;
    if (remaining > SESSION_RENEW_THRESHOLD_MS) return;

    const nextExpiresAt = Math.min(now + SESSION_IDLE_TTL_MS, this.record.maxExpiresAt);
    if (nextExpiresAt <= this.record.sessionExpiresAt) return;

    await this.updateRecord((record) => {
      record.sessionExpiresAt = nextExpiresAt;
    });
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm() {
    if (this.record.state === "closed") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadlines = [
      this.record.sessionExpiresAt,
      this.record.hostDisconnectDeadline,
      this.record.pendingRequestExpiresAt,
      this.record.controlLeaseExpiresAt,
    ].filter((value): value is number => typeof value === "number" && value > Date.now());

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }
}

function parseEnvelope(value: string): { type?: string; payload?: unknown } | null {
  try {
    return JSON.parse(value) as { type?: string; payload?: unknown };
  } catch {
    return null;
  }
}

function normalizeLeaseSeconds(payload: unknown, fallback = DEFAULT_CONTROL_LEASE_SECONDS) {
  const value = (payload as { leaseSeconds?: unknown })?.leaseSeconds;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(60, Math.min(Math.trunc(value), DEFAULT_CONTROL_LEASE_SECONDS));
}

function normalizeTerminalSize(payload: unknown): TerminalSize | null {
  const size = payload as { cols?: unknown; rows?: unknown };
  if (typeof size.cols !== "number" || typeof size.rows !== "number") {
    return null;
  }
  if (!Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
    return null;
  }

  const cols = Math.trunc(size.cols);
  const rows = Math.trunc(size.rows);
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
    return null;
  }
  return { cols, rows };
}

function normalizeTerminalProfile(payload: unknown): TerminalProfile | null {
  const profile = payload as { platform?: unknown; pty?: unknown };
  if (profile?.platform === "unix") {
    return { platform: "unix" };
  }
  if (profile?.platform === "windows" && profile.pty === "conpty") {
    return { platform: "windows", pty: "conpty" };
  }
  return null;
}

function randomViewerToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function validViewerToken(value: string | null) {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    return null;
  }
  return value;
}
