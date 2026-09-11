import { spawn } from 'node:child_process';

export const PTY_MAX_BYTES = 4 * 1024 * 1024;
export const PTY_DEADLINE_MS = 30_000;
export const COLS = 120;
export const ROWS = 60;
export interface CaptureOptions {
  bin: string;
  durationMs?: number;
  usageAtMs?: number;
  deadlineMs?: number;
  maxBytes?: number;
}

// argv carries paths; no shell or generated files are needed. The PTY child
// owns a session, so its PID also identifies the process group to terminate.
const PYTHON_DRIVER = `import os, pty, time, select, signal, struct, fcntl, termios, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], [sys.argv[1]], os.environ)
    os._exit(127)
sys.stderr.write(str(pid) + "\\n"); sys.stderr.flush()
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ${ROWS}, ${COLS}, 0, 0))
    start = time.monotonic(); sent = False; size = 0
    while time.monotonic() - start < float(sys.argv[2]):
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: data = os.read(fd, 8192)
            except OSError: break
            if not data: break
            size += len(data)
            if size > int(sys.argv[4]): sys.exit(2)
            sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
        if not sent and time.monotonic() - start >= float(sys.argv[3]):
            try: os.write(fd, b"/usage\\r")
            except OSError: break
            sent = True
finally:
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(fd)
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
`;

export async function captureViaPython(opts: CaptureOptions): Promise<Buffer | null> {
  if (process.platform === 'win32') return null;
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-c', PYTHON_DRIVER, opts.bin,
      String((opts.durationMs ?? 23_000) / 1000), String((opts.usageAtMs ?? 10_000) / 1000),
      String(opts.maxBytes ?? PTY_MAX_BYTES)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let pid: number | undefined;
    let pidLine = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (): void => { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } };
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      killGroup();
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => { killGroup(); proc.kill('SIGKILL'); }, 500);
    };
    const onInt = (): void => { process.exitCode = 130; stop(new Error('PTY capture interrupted')); };
    const onTerm = (): void => { process.exitCode = 143; stop(new Error('PTY capture interrupted')); };
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    const timer = setTimeout(() => stop(new Error('PTY capture timed out')), opts.deadlineMs ?? PTY_DEADLINE_MS);
    proc.stderr.on('data', (data: Buffer) => {
      if (pid || pidLine.length > 32) return;
      pidLine += data.toString('utf8');
      const match = pidLine.match(/^(\d+)\n/);
      if (match) { pid = Number(match[1]); if (failure) killGroup(); }
    });
    proc.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > (opts.maxBytes ?? PTY_MAX_BYTES)) stop(new Error('PTY output exceeded limit'));
      else if (!failure) chunks.push(data);
    });
    // close fires after streams close, including when spawn fails.
    proc.on('error', () => { /* unavailable backend; close resolves null */ });
    proc.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      if (failure) reject(failure);
      else if (code === 2) reject(new Error('PTY output exceeded limit'));
      else resolve(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

/** Loader injection keeps tests independent of optional native binaries. */
export async function captureViaNodePty(opts: CaptureOptions, load = async (): Promise<any> => {
  const name: string = 'node-pty';
  return import(name);
}): Promise<Buffer | null> {
  let pty: any;
  try { pty = await load(); } catch { return null; }
  return new Promise((resolve, reject) => {
    let term: any;
    try { term = pty.spawn(opts.bin, [], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(), env: process.env }); }
    catch { resolve(null); return; }
    let done = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const disposables: { dispose(): void }[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      disposables.forEach((d) => d.dispose());
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      try { term.kill('SIGKILL'); } catch { /* already exited */ }
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const onInt = (): void => { process.exitCode = 130; finish(new Error('PTY capture interrupted')); };
    const onTerm = (): void => { process.exitCode = 143; finish(new Error('PTY capture interrupted')); };
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    timers.push(setTimeout(() => { try { term.write('/usage\r'); } catch { /* may exit early */ } }, opts.usageAtMs ?? 10_000));
    timers.push(setTimeout(() => finish(), opts.durationMs ?? 23_000));
    timers.push(setTimeout(() => finish(new Error('PTY capture timed out')), opts.deadlineMs ?? PTY_DEADLINE_MS));
    disposables.push(term.onData((data: string) => {
      const chunk = Buffer.from(data);
      size += chunk.length;
      if (size > (opts.maxBytes ?? PTY_MAX_BYTES)) finish(new Error('PTY output exceeded limit'));
      else if (!done) chunks.push(chunk);
    }));
    disposables.push(term.onExit(() => finish()));
  });
}
