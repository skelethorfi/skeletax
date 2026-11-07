// Prints how far a long step has got, e.g. '[THORChain] thor1…: actions 120/2000, about 31 min left': at most once
// every intervalMs, so a short step prints nothing, and once at the end if it printed before. now and log are
// for tests.
export class Progress {
  private readonly label: string;
  private readonly total: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly start: number;
  private lastLog: number;
  private count = 0;
  private logged = false;

  constructor(
    label: string,
    total: number,
    intervalMs = 10_000,
    now: () => number = Date.now,
    log: (line: string) => void = console.log,
  ) {
    this.label = label;
    this.total = total;
    this.intervalMs = intervalMs;
    this.now = now;
    this.log = log;
    this.start = now();
    this.lastLog = this.start;
  }

  // One more item done
  done() {
    this.count++;
    const now = this.now();

    if (this.count === this.total ? this.logged : now - this.lastLog >= this.intervalMs) {
      this.lastLog = now;
      this.logged = true;
      this.log(`${this.label} ${this.count}/${this.total}${this.eta(now)}`);
    }
  }

  private eta(now: number): string {
    if (this.count === this.total) {
      return `, done in ${formatDuration(now - this.start)}`;
    }

    const left = ((now - this.start) / this.count) * (this.total - this.count);
    return `, about ${formatDuration(left)} left`;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
