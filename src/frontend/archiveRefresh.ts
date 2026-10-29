// Open archive windows list their folder once and keep it. When something
// changes the archive (files added to it), the code that did it calls
// `notifyArchiveChanged` and every window showing that archive reloads. Windows
// are matched by container session key and archive path, so a second container
// with an archive of the same path is left alone.

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

const keyOf = (containerKey: string, archive: string): string =>
  `${containerKey}\n${archive}`;

/** Calls `onChange` whenever this archive is changed; returns the unsubscribe. */
export function subscribeArchiveChanged(
  containerKey: string,
  archive: string,
  onChange: Listener,
): () => void {
  const key = keyOf(containerKey, archive);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  // A fresh wrapper, so subscribing the same function twice counts twice.
  const own: Listener = () => onChange();
  set.add(own);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(own);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Tells every open window of this archive to reload; returns how many. */
export function notifyArchiveChanged(
  containerKey: string,
  archive: string,
): number {
  const set = listeners.get(keyOf(containerKey, archive));
  if (!set) return 0;
  // A listener may unsubscribe while being called.
  const now = [...set];
  for (const fn of now) fn();
  return now.length;
}
