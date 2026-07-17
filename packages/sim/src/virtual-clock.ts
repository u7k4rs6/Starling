/**
 * Virtual clock (ARCH §4, part 2). No `setTimeout`, no real time — time
 * advances only because the caller says so, by how much the caller says.
 * This is why the core isolation gate (ARCH §1 gate 1) bans ambient
 * clock/timer reads: a CRDT (or provider, once Step 9 needs real-ish delay
 * logic) that read the wall clock instead of taking time as an argument
 * could never be driven deterministically by this.
 */
type Scheduled = { time: number; seq: number; callback: () => void };

export class VirtualClock {
  private currentTime = 0;
  private readonly scheduled: Scheduled[] = [];
  private seq = 0;

  now(): number {
    return this.currentTime;
  }

  scheduleAt(time: number, callback: () => void): void {
    if (time < this.currentTime) {
      throw new RangeError(`cannot schedule at ${time}, already at ${this.currentTime}`);
    }
    this.scheduled.push({ time, seq: this.seq, callback });
    this.seq += 1;
  }

  scheduleAfter(delay: number, callback: () => void): void {
    this.scheduleAt(this.currentTime + delay, callback);
  }

  /** Advance to `time`, running every callback scheduled at or before it,
   * strictly in (time, seq) order — including callbacks a running
   * callback itself schedules, as long as they're still due by `time`. */
  advanceTo(time: number): void {
    if (time < this.currentTime) {
      throw new RangeError(`cannot advance backward from ${this.currentTime} to ${time}`);
    }
    for (;;) {
      let dueIndex = -1;
      for (let i = 0; i < this.scheduled.length; i += 1) {
        const candidate = this.scheduled[i]!;
        if (candidate.time > time) continue;
        if (dueIndex === -1) {
          dueIndex = i;
          continue;
        }
        const due = this.scheduled[dueIndex]!;
        if (candidate.time < due.time || (candidate.time === due.time && candidate.seq < due.seq)) {
          dueIndex = i;
        }
      }
      if (dueIndex === -1) break;
      const [entry] = this.scheduled.splice(dueIndex, 1);
      this.currentTime = entry!.time;
      entry!.callback();
    }
    this.currentTime = time;
  }

  advanceBy(delta: number): void {
    this.advanceTo(this.currentTime + delta);
  }

  get pendingCount(): number {
    return this.scheduled.length;
  }
}
