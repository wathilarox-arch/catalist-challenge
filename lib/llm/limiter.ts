export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export class RequestLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private token = 1;
  private lastRefill: number;
  private readonly interval: number;

  constructor(rpm: number, private readonly concurrency: number, private readonly clock: Clock) {
    this.interval = 60_000 / rpm;
    this.lastRefill = clock.now();
  }

  async run<T>(request: () => Promise<T>): Promise<T> {
    if (this.active === this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;

    try {
      // A one-token bucket spaces starts evenly even when several callers are queued.
      while (true) {
        const now = this.clock.now();
        this.token = Math.min(1, this.token + (now - this.lastRefill) / this.interval);
        this.lastRefill = now;
        if (this.token >= 1) {
          this.token--;
          break;
        }
        await this.clock.sleep(Math.ceil((1 - this.token) * this.interval));
      }
      return await request();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
