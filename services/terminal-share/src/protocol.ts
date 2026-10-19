export const BinaryMessageType = {
  ttyOutput: 0x01,
  stdin: 0x02,
} as const;

export async function binarySocketDataToArrayBuffer(
  data: unknown,
): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer();
  }
  return null;
}

export function decodeBinaryMessage(
  buffer: ArrayBuffer,
): { messageType: number; payload: ArrayBuffer } | null {
  if (buffer.byteLength === 0) {
    return null;
  }
  const bytes = new Uint8Array(buffer);
  return {
    messageType: bytes[0],
    payload: buffer.slice(1),
  };
}

export function binaryMessageType(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength === 0) {
    return null;
  }
  return new Uint8Array(buffer, 0, 1)[0];
}

export function encodeBinaryMessage(messageType: number, payload: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(payload.length + 1);
  message[0] = messageType;
  message.set(payload, 1);
  return message.buffer;
}
