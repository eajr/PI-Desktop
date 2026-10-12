export type MicrophoneOwner = "live";

/**
 * Main-process microphone lease. One owner token holds capture at a time, so a
 * stale or second Live call cannot reuse the microphone of the active one.
 */
export class MicrophoneLeaseRegistry {
  private lease: { owner: MicrophoneOwner; token: string } | null = null;

  acquire(owner: MicrophoneOwner, token: string): () => void {
    if (this.lease && (this.lease.owner !== owner || this.lease.token !== token)) {
      throw Object.assign(new Error("The microphone is already in use"), { errorCode: "LIVE_MICROPHONE_BUSY" });
    }
    this.lease = { owner, token };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.lease?.owner === owner && this.lease.token === token) this.lease = null;
    };
  }

  isHeld(): boolean {
    return this.lease !== null;
  }
}
