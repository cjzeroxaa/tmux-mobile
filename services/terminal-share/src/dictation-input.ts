// Insert never submits a terminal command, even without bracketed paste mode.
export function dictationTerminalText(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
