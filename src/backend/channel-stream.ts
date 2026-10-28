import { PassThrough } from "node:stream";
import { cpError } from "./cp-io.js";
import { channelDone, openChannel, openChannelAbortable } from "./exec.js";
import type { ListTarget } from "./fs-list.js";
import { cpFromCommand } from "./tar.js";

export type Channel = Awaited<ReturnType<typeof openChannel>>;

export interface CpSource {
  /** The tar stream `cp` writes; errors with a mapped HttpError if cp fails. */
  stream: PassThrough;
  channel: Channel;
  /** Stops reading: destroys the channel and the stream. */
  close: () => void;
}

/**
 * Opens `cp <container>:<path> -` and exposes its stdout as a Readable with
 * backpressure. `onBytes` sees every chunk (progress). The stream ends when cp
 * exits 0 and errors with the mapped cp error otherwise.
 */
export async function openCpSource(
  t: ListTarget,
  path: string,
  onBytes?: (n: number) => void,
  signal?: AbortSignal,
): Promise<CpSource> {
  signal?.throwIfAborted();
  const channel = await openChannelAbortable(
    t.client,
    cpFromCommand(t.runtime, t.containerId, path),
    signal,
  );
  const stderr = { text: "" };
  const done = channelDone(channel, stderr);
  done.catch(() => {});
  const stream = new PassThrough();
  let closed = false;

  channel.on("data", (chunk: Buffer) => {
    if (closed) return;
    onBytes?.(chunk.length);
    if (!stream.write(chunk)) {
      channel.pause();
      stream.once("drain", () => channel.resume());
    }
  });
  channel.once("close", () => {
    done.then(
      () => {
        if (!closed) stream.end();
      },
      () => {
        if (!closed) stream.destroy(cpError(stderr.text));
      },
    );
  });
  channel.once("error", (e: Error) => {
    if (!closed) stream.destroy(e);
  });

  return {
    stream,
    channel,
    close: () => {
      closed = true;
      channel.destroy();
      stream.destroy();
    },
  };
}
