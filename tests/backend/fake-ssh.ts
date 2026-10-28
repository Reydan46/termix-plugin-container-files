import { EventEmitter } from "node:events";
import type { Client } from "ssh2";

/** An ssh2 exec channel: stdout on "data", stderr on `stderr`, then "close". */
export class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
  written: Buffer[] = [];
  ended = false;
  destroyed = false;
  paused = false;

  write(data: Buffer | string) {
    this.written.push(Buffer.from(data));
    return true;
  }

  end(data?: Buffer | string) {
    if (data !== undefined) this.write(data);
    this.ended = true;
  }

  /** Like ssh2: destroying a channel closes it (exit code 1, no stdout). */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    setImmediate(() => this.emit("close", 1));
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  /** Emits output and exits, on the next tick like a real channel. */
  finish(stdout: Buffer | string, code = 0, stderr = "") {
    setImmediate(() => {
      if (stdout.length) this.emit("data", Buffer.from(stdout));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      this.emit("exit", code);
      this.emit("close", code);
    });
  }
}

export interface ExecReplyData {
  stdout?: Buffer | string;
  stderr?: string;
  code?: number;
}
export type ExecReply = ExecReplyData | ((stream: FakeStream) => void);

/** An ssh2 Client that answers exec by the first matching pattern. */
export class FakeClient extends EventEmitter {
  commands: string[] = [];
  streams: FakeStream[] = [];

  constructor(private replies: Array<[RegExp, ExecReply]> = []) {
    super();
  }

  reply(pattern: RegExp, reply: ExecReply) {
    this.replies.unshift([pattern, reply]);
  }

  /** Options passed to exec (for example a pty request), by command. */
  execOptions: unknown[] = [];

  exec(
    command: string,
    optionsOrCallback:
      | Record<string, unknown>
      | ((err: Error | undefined, stream: FakeStream) => void),
    maybeCallback?: (err: Error | undefined, stream: FakeStream) => void,
  ) {
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback!;
    this.execOptions.push(
      typeof optionsOrCallback === "function" ? undefined : optionsOrCallback,
    );
    this.commands.push(command);
    const stream = new FakeStream();
    this.streams.push(stream);
    const match = this.replies.find(([pattern]) => pattern.test(command));
    callback(undefined, stream);
    if (!match) {
      stream.finish("");
      return this;
    }
    const reply = match[1];
    if (typeof reply === "function") reply(stream);
    else stream.finish(reply.stdout ?? "", reply.code ?? 0, reply.stderr ?? "");
    return this;
  }

  ended = false;

  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit("close");
  }

  asClient(): Client {
    return this as unknown as Client;
  }
}
