import type { SoundMaterial } from '../world/blocks';
import { clamp } from '../core/types';

/**
 * 程序化音效：WebAudio 合成，零音频资源。
 * 挖掘 / 放置 / 脚步 / 引信 / 爆炸 / UI，全部与可见事件绑定。
 */
export class SoundEngine {
  enabled = true;
  /** 音量 0~1，默认 0.5（设置页可调） */
  volume = 0.5;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private eatTimeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** 必须在用户手势中调用一次以解锁音频 */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);
      // 3s：最长音效是 TNT 引信 1.5s，慢速 playbackRate（0.7）下需要约 2.2s 素材，
      // 再加随机 offset 0.2s 也留有余量；0.5s 会让引信 / 爆炸被截断。
      const len = this.ctx.sampleRate * 3;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
    }
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? this.volume : 0;
  }

  /** 音量 0~100（设置页滑杆值），立即生效 */
  setVolume(v: number) {
    this.volume = clamp(v, 0, 100) / 100;
    if (this.master && this.enabled) this.master.gain.value = this.volume;
  }

  /** 清理音频资源，取消所有挂起的定时器 */
  dispose(): void {
    this.disposed = true;
    if (this.eatTimeout) {
      clearTimeout(this.eatTimeout);
      this.eatTimeout = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.master = null;
    this.noiseBuf = null;
  }

  private burst(freq: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass', q = 1.2) {
    if (!this.ctx || !this.master || !this.noiseBuf || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.2, dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'square', slideTo?: number) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** 音高微随机：同一动作连续触发时不腻，幅度按音色需求调整 */
  private vary(freq: number, amount = 0.1): number {
    return freq * (1 + (Math.random() * 2 - 1) * amount);
  }

  private matFreq(mat: SoundMaterial): number {
    switch (mat) {
      case 'stone': return 720;
      case 'dirt': return 300;
      case 'wood': return 480;
      case 'sand': return 1100;
      case 'glass': return 1700;
      case 'cloth': return 240;
      case 'plant': return 900;
      case 'liquid': return 500;
    }
  }

  dig(mat: SoundMaterial, hardness = 1) {
    const f = this.vary(this.matFreq(mat), 0.1);
    this.burst(f, 0.14, 0.5, 'bandpass', 1.4);
    if (mat === 'glass') this.tone(this.vary(2200), 0.1, 0.12, 'triangle', 1400);
    if (mat === 'stone') this.burst(f * 0.5, 0.1, 0.25, 'lowpass');
    void hardness;
  }

  place(mat: SoundMaterial) {
    const f = this.vary(this.matFreq(mat) * 0.8);
    this.burst(f, 0.1, 0.42, 'bandpass', 1.6);
    this.tone(this.vary(f * 0.5, 0.08), 0.06, 0.1, 'triangle');
  }

  step(mat: SoundMaterial, gain = 0.16) {
    this.burst(this.vary(this.matFreq(mat), 0.2), 0.07, gain, 'lowpass', 0.8);
  }

  splash() {
    this.burst(900, 0.25, 0.3, 'lowpass', 0.7);
  }

  /** 受伤：短促下滑的低音 */
  hurt() {
    this.burst(this.vary(180, 0.08), 0.22, 0.34, 'lowpass', 0.7);
  }

  /** 近战命中：干脆的打击感，加一记高频「咔」让命中确认更明确 */
  hit() {
    this.burst(this.vary(420, 0.12), 0.1, 0.34, 'bandpass', 2.2);
    this.tone(this.vary(1200, 0.1), 0.045, 0.1, 'square', 600);
  }

  /** 进食：两段咀嚼 */
  eat() {
    this.burst(this.vary(260, 0.1), 0.08, 0.22, 'lowpass', 1.2);
    setTimeout(() => this.burst(this.vary(210, 0.1), 0.08, 0.18, 'lowpass', 1.2), 160);
  }

  fuse() {
    this.burst(this.vary(3200, 0.06), 1.5, 0.16, 'highpass', 0.6);
  }

  explosion() {
    if (!this.ctx || !this.master || !this.enabled) return;
    this.burst(this.vary(180, 0.12), 0.7, 0.9, 'lowpass', 0.5);
    this.burst(this.vary(60, 0.1), 0.9, 0.8, 'lowpass', 0.4);
    this.tone(this.vary(110, 0.08), 0.6, 0.5, 'sine', 30);
  }

  click(freq = 660) {
    this.tone(this.vary(freq, 0.05), 0.06, 0.12, 'square');
  }
}