export function bindStreamingDictation(options: {
  button: HTMLButtonElement | null;
  input?: HTMLElement;
  getText: () => string;
  setText: (text: string) => void;
  setStatus: (status: string) => void;
  isBlocked?: () => boolean;
  onActive?: (active: boolean) => void;
  controls?: (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null)[];
  getStreamUrl?: () => string;
  disableWhenBlocked?: boolean;
}): { cancel(): void; refresh(): void; readonly active: boolean };
