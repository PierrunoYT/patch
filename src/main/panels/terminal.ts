import { spawn, type IPty } from 'node-pty';

function userShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

// The interactive terminal panel: one shell per project, for the user (the agent runs its commands separately).
export class TerminalService {
  private pty: IPty | null = null;
  private cwd: string | null = null;

  constructor(
    private readonly onData: (data: string) => void,
    private readonly onExit: () => void,
  ) {}

  // Starts a shell in cwd, or keeps the running one if it is already there.
  start(cwd: string, cols: number, rows: number): void {
    if (this.pty && this.cwd === cwd) {
      this.resize(cols, rows);
      // A new window has an empty screen (the shell survives a closed window on macOS): ask the shell to redraw.
      this.pty.write('\x0c');
      return;
    }
    this.stop();
    const { file, args } = userShell();
    const pty = spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      cwd,
      env: process.env as Record<string, string>,
      // node-pty's default Windows ConPTY kill path forks a console-list helper which can race a quick close.
      // The bundled ConPTY implementation tears down synchronously without spawning that helper.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
    });
    // Output of a shell already replaced (a project switch) must not land in the new project's terminal (#259).
    pty.onData((data) => {
      if (this.pty === pty) this.onData(data);
    });
    pty.onExit(() => {
      if (this.pty === pty) {
        this.pty = null;
        this.onExit();
      }
    });
    this.pty = pty;
    this.cwd = cwd;
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.pty && cols > 1 && rows > 1) this.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  stop(): void {
    const pty = this.pty;
    this.pty = null;
    this.cwd = null;
    try {
      pty?.kill();
    } catch {
      // Already exited.
    }
  }
}
