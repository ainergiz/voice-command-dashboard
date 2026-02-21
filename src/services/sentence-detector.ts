// Detects sentence boundaries in streaming transcript text.

export class SentenceDetector {
  private buffer = "";
  private sentenceCount = 0;
  private lastFlushTime = Date.now();

  /**
   * Feed new transcript text. Returns complete sentences extracted from the buffer.
   */
  feed(text: string): string[] {
    const chunk = text.trim();
    if (!chunk) return [];

    this.buffer += (this.buffer ? " " : "") + chunk;
    const normalized = this.buffer.trim();
    if (!normalized) return [];

    const parts = normalized.split(/(?<=[.!?])\s+/);
    const endsWithBoundary = /[.!?]\s*$/.test(normalized);
    const completedParts = endsWithBoundary ? parts : parts.slice(0, -1);
    const sentences = completedParts
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (sentences.length > 0) {
      this.sentenceCount += sentences.length;
      this.lastFlushTime = Date.now();
    }

    this.buffer = endsWithBoundary ? "" : (parts[parts.length - 1] ?? "");

    return sentences;
  }

  /**
   * Force-flush the buffer as a sentence (used on timeout or session end).
   */
  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = "";
    if (text.length > 0) {
      this.sentenceCount++;
      this.lastFlushTime = Date.now();
      return text;
    }
    return null;
  }

  /**
   * Check if we should trigger deep analysis based on sentence count or time.
   * Triggers every 3 sentences or every 15 seconds.
   */
  shouldTriggerDeep(sentencesSinceLastDeep: number): boolean {
    if (sentencesSinceLastDeep >= 3) return true;
    if (Date.now() - this.lastFlushTime > 15_000 && this.buffer.trim().length > 0) return true;
    return false;
  }

  get totalSentences(): number {
    return this.sentenceCount;
  }

  get pendingText(): string {
    return this.buffer;
  }

  get timeSinceLastFlush(): number {
    return Date.now() - this.lastFlushTime;
  }
}
