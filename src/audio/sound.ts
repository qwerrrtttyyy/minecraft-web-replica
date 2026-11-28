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
  /** 常驻循环雨声：单实例噪声源，避免反复 start 叠加成噪音 */
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainLevel = 0;

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
      // 常驻雨声底噪：噪声源 → lowpass → 增益；setRainLevel 淡入淡出
      this.rainSrc = this.ctx.createBufferSource();
      this.rainSrc.buffer = this.noiseBuf;
      this.rainSrc.loop = true;
      this.rainFilter = this.ctx.createBiquadFilter();
      this.rainFilter.type = 'lowpass';
      this.rainFilter.frequency.value = 2600;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0;
      this.rainSrc.connect(this.rainFilter).connect(this.rainGain).connect(this.master);
      this.rainSrc.start();
    } catch {
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
    }
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? this.volume : 0;
    this.applyRain();
  }

  /** 雨声强度 0~1，淡入淡出；无上下文时静默 no-op（CI / 未解锁音频） */
  setRainLevel(level: number): void {
    this.rainLevel = clamp(level, 0, 1);
    this.applyRain();
  }

  private applyRain(): void {
    if (!this.ctx || !this.rainGain) return;
    const target = this.enabled ? this.rainLevel * 0.12 : 0;
    this.rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
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
    if (this.rainSrc) {
      try { this.rainSrc.stop(); } catch { /* 已停止 */ }
      this.rainSrc.disconnect();
      this.rainSrc = null;
    }
    this.rainFilter = null;
    this.rainGain = null;
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

  /** 火焰引燃：短促的噼啪噪声（PR3 火焰蔓延） */
  crackle() {
    this.burst(this.vary(1500, 0.25), 0.07, 0.2, 'highpass', 0.8);
  }

  /** 熔炉烤熟：短促高频「叮」，上行滑音让提示更明确 */
  ding() {
    this.tone(this.vary(1560, 0.05), 0.09, 0.16, 'triangle', 2093);
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

  /** 投掷篮球：短促上扬的「咻」，与放置 / 进食明确区分 */
  throwBall() {
    this.burst(this.vary(560, 0.12), 0.16, 0.3, 'bandpass', 1.1);
    this.tone(this.vary(320, 0.08), 0.12, 0.12, 'triangle', 620);
  }

  /** 篮球落地弹跳：力度越大越沉、越响 */
  bounce(strength: number) {
    const s = Math.max(0, Math.min(1, strength / 24));
    this.burst(this.vary(200 + s * 260, 0.1), 0.1 + s * 0.06, 0.2 + s * 0.28, 'lowpass', 0.9);
    this.tone(this.vary(150 + s * 120, 0.08), 0.07, 0.08 + s * 0.06, 'sine');
  }

  /** 篮球拾取：清脆两连音 */
  pickup() {
    this.tone(this.vary(880, 0.04), 0.07, 0.14, 'square');
    setTimeout(() => this.tone(this.vary(1320, 0.04), 0.08, 0.12, 'square'), 80);
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

  /** 雷声：复用爆炸的低频轰鸣，叠一记高频裂帛 */
  thunder() {
    this.explosion();
    this.burst(this.vary(1800, 0.2), 0.25, 0.16, 'highpass', 0.8);
  }

  click(freq = 660) {
    this.tone(this.vary(freq, 0.05), 0.06, 0.12, 'square');
  }
}