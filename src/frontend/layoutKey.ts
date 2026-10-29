// Shortcut letters on any keyboard layout. With Ctrl or Cmd held, a layout
// such as Russian reports `key` "с" for the physical C key, so a handler that
// switches on `key` never sees Ctrl+C. When the key is not a Latin letter the
// physical key (`code` "KeyC") names the shortcut instead; a Latin layout (or
// Dvorak, AZERTY) keeps its own letter.

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** `event.key`, except Ctrl/Cmd + a non-Latin letter becomes the Latin letter of its physical key. */
export function layoutKey(event: KeyLike): string {
  if (!(event.ctrlKey || event.metaKey)) return event.key;
  if (event.key.length !== 1 || /[A-Za-z]/.test(event.key)) return event.key;
  const match = /^Key([A-Z])$/.exec(event.code ?? "");
  return match ? match[1].toLowerCase() : event.key;
}
