// Minimal radix-2 FFT for square complex images. No dependencies.
export class FFT2 {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.n = n;
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
  }

  // In-place 1D FFT on a strided segment.
  fft1d(re, im, off, stride, inverse) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = off + i * stride, b = off + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (sign * 2 * Math.PI) / len;
      for (let k = 0; k < half; k++) {
        this.cos[k] = Math.cos(ang * k);
        this.sin[k] = Math.sin(ang * k);
      }
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k], wi = this.sin[k];
          const a = off + (i + k) * stride;
          const b = off + (i + k + half) * stride;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  forward(re, im) {
    const n = this.n;
    for (let y = 0; y < n; y++) this.fft1d(re, im, y * n, 1, false);
    for (let x = 0; x < n; x++) this.fft1d(re, im, x, n, false);
  }

  inverse(re, im) {
    const n = this.n;
    for (let y = 0; y < n; y++) this.fft1d(re, im, y * n, 1, true);
    for (let x = 0; x < n; x++) this.fft1d(re, im, x, n, true);
    const s = 1 / (n * n);
    for (let i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; }
  }
}

// C = IFFT2(FD * conj(FQ)); caller reuses out arrays.
export function correlate(fft, fdRe, fdIm, fqRe, fqIm, outRe, outIm) {
  const n = fft.n;
  for (let i = 0; i < n * n; i++) {
    const ar = fdRe[i], ai = fdIm[i], br = fqRe[i], bi = -fqIm[i];
    outRe[i] = ar * br - ai * bi;
    outIm[i] = ar * bi + ai * br;
  }
  fft.inverse(outRe, outIm);
}
