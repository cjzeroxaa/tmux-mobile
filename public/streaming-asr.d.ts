export function bindStreamingDictation(options: {
  button: HTMLButtonElement | null;
  input?: HTMLElement;
  submitButton?: HTMLButtonElement;
  getText: () => string;
  setText: (text: string) => void;
  setStatus: (status: string) => void;
  isBlocked?: () => boolean;
  onActive?: (active: boolean) => void;
  controls?: (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null)[];
  getStreamUrl?: () => string;
  disableWhenBlocked?: boolean;
}): { cancel(): void; submit(send: (text: string) => Promise<void>): Promise<void>; refresh(): void; readonly active: boolean };
