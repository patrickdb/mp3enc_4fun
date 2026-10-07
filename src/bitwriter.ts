/** Append-only bit buffer; bits are written most-significant first, as MP3 requires. */
export class BitWriter {
  private bytes = new Uint8Array(256);
  private bits = 0;

  get bitLength(): number {
    return this.bits;
  }

  writeBits(value: number, n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 32) throw new RangeError(`bit width out of range: ${String(n)}`);
    for (let i = n - 1; i >= 0; i--) {
      this.pushBit(Math.floor(value / 2 ** i) % 2);
    }
  }

  /** Writes a code given as a string of '0'/'1' characters. */
  writeCode(code: string): void {
    for (let i = 0; i < code.length; i++) this.pushBit(code.charCodeAt(i) === 49 ? 1 : 0);
  }

  append(other: BitWriter): void {
    for (let i = 0; i < other.bits; i++) {
      this.pushBit(((other.bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1);
    }
  }

  /** Returns the written bits, zero-padded to a whole number of bytes. */
  toBytes(): Uint8Array {
    return this.bytes.slice(0, (this.bits + 7) >> 3);
  }

  private pushBit(bit: number): void {
    const index = this.bits >> 3;
    if (index >= this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    if (bit !== 0) this.bytes[index] = (this.bytes[index] ?? 0) | (0x80 >> (this.bits & 7));
    this.bits++;
  }
}
