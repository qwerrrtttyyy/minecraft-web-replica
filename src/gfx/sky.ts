import * as THREE from 'three';
import { Noise } from '../world/noise';
import { clamp, lerp, smoothstep, mulberry32, type System } from '../core/types';
import type { EventService } from '../services/events';

/** 水下环境色：天穹整体压向这一色相，与 HUD 的水下叠层共同构成水下氛围 */
const UNDERWATER_SKY = 0x0e2f5e;
/** 水下雾色（比天穹更饱和一点，靠近观察者处仍保留可读性） */
const UNDERWATER_FOG = 0x124079;

/**
 * 天空系统：渐变天穹 + 方形太阳/月亮 + 星空 + 体素云层 + 昼夜循环。
 * 同时驱动世界亮度、雾色与实体光照。
 */
export class Sky implements System {
  readonly name = 'sky';
  /** 0=午夜 0.25=日出 0.5=正午 0.75=日落 */
  dayTime = 0.32;
  dayLength = 600;
  daylight = 1;

  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh;
  private cloudBaseX = 0;
  private cloudBaseZ = 0;
  readonly sunLight: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** 当前太阳颜色（日出/日落偏暖），区块 shader 用它给天空光染色 */
  readonly sunTint = new THREE.Color(0xffffff);
  private fog: THREE.Fog;
  private group = new THREE.Group();
  private emitAcc = 0;
  /** 本地累计时间：暂停期间 sky.update 不被调用，恢复后云与星空不会跳变 */
  private localTime = 0;
  /** 目标状态：相机是否没入水中（由 main 每帧写入） */
  private submerged = false;
  /** 平滑后的水下强度 0~1，避免入水瞬间雾与天穹硬切 */
  private sub = 0;

  private cDayTop = new THREE.Color(0x5f9dff);
  private cDayHorizon = new THREE.Color(0xc4ddff);
  private cNightTop = new THREE.Color(0x060a1c);
  private cNightHorizon = new THREE.Color(0x131a32);
  private cDusk = new THREE.Color(0xff9a4a);
  private tmpTop = new THREE.Color();
  private tmpHorizon = new THREE.Color();
  private tmpSun = new THREE.Color();
  /** 每帧复用的临时对象：update() 不再分配 Vector3 / Color */
  private tmpSunDir = new THREE.Vector3();
  private cDuskTop = new THREE.Color(0x4a5a8a);
  private cSunset = new THREE.Color(0xff8a3c);
  private cWhite = new THREE.Color(0xffffff);
  private cWarm = new THREE.Color(0xffb066);
  private cUnderFog = new THREE.Color(UNDERWATER_FOG);
  private tmpUnder = new THREE.Color();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private getRenderDistance: () => number,
    private events: EventService,
    isMobile: boolean,
  ) {
    // 天穹
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff2c0) },
        uDaylight: { value: 1 },
        uWater: { value: new THREE.Color(UNDERWATER_SKY) },
        uSub: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir;
        uniform vec3 uSunColor; uniform float uDaylight;
        uniform vec3 uWater; uniform float uSub;
        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, 0.0, 1.0);
          // smootherstep 曲线：比 pow(h, 0.58) 更连续，地平线附近保留更多雾色衔接
          float t = h * h * h * (h * (h * 6.0 - 15.0) + 10.0);
          vec3 col = mix(uHorizon, uTop, t * 0.92 + h * 0.08);
          vec3 sd = normalize(uSunDir);
          float d = max(dot(dir, sd), 0.0);
          float vis = smoothstep(-0.12, 0.05, sd.y);
          col += uSunColor * pow(d, 90.0) * 0.5 * vis;
          col += uSunColor * pow(d, 8.0) * 0.14 * vis;
          // 地平线霞光带：把日出/日落的暖色压向贴近地平线的窄带，并与太阳方位对齐
          vec2 hz = dir.xz; vec2 sh = sd.xz;
          float hl = length(hz) * length(sh);
          if (hl > 1e-4) {
            float az = max(dot(hz, sh) / hl, 0.0);
            float band = exp(-abs(dir.y) * 5.5);
            col += uSunColor * pow(az, 3.0) * band * 0.22 * vis * (1.0 - uDaylight * 0.55);
          }
          float md = max(dot(dir, -sd), 0.0);
          col += vec3(0.7, 0.8, 1.0) * pow(md, 120.0) * 0.22 * (1.0 - uDaylight);
          col = mix(col, uWater, uSub);
          // 8bit 输出下的蓝噪声式抖动，消除大面积天穹渐变肉眼可见的色带
          float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          gl_FragColor = vec4(col + (n - 0.5) / 255.0, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(460, 32, 16), this.domeMat);
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    // 太阳 / 月亮（原版风格的方形贴图）
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshBasicMaterial({ map: makeSunTexture(), transparent: true, fog: false, depthWrite: false }),
    );
    this.sun.renderOrder = -8;
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshBasicMaterial({ map: makeMoonTexture(), transparent: true, fog: false, depthWrite: false }),
    );
    this.moon.renderOrder = -8;
    this.group.add(this.sun, this.moon);

    // 星空
    const rng = mulberry32(20261113);
    const starPos: number[] = [];
    const starCount = isMobile ? 450 : 750;
    for (let i = 0; i < starCount; i++) {
      const az = rng() * Math.PI * 2;
      const el = Math.asin(rng() * 0.98);
      const r = 430;
      starPos.push(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xdde6ff, size: 2.2, sizeAttenuation: false, transparent: true,
      opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -9;
    this.group.add(this.stars);

    // 体素云
    this.clouds = this.buildClouds(isMobile);
    this.group.add(this.clouds);
    scene.add(this.group);

    // 雾
    this.fog = new THREE.Fog(0xc4ddff, 60, 140);
    scene.fog = this.fog;

    // 实体光照
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x8a7f6a, 0.6);
    scene.add(this.sunLight, this.sunLight.target, this.hemi);
  }

  private buildClouds(isMobile: boolean): THREE.Mesh {
    const cell = 12;
    const n = isMobile ? 36 : 48;
    const noise = new Noise(777);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const y = 80;
    const thick = 3.2;
    const half = (n * cell) / 2;
    // 逐面烘焙明暗（顶亮 / 底暗 / 侧面区分 x、z 轴），让方块云读成有厚度的体素而非白色纸片
    const shade = [1, 0.58, 0.72, 0.86, 0.66, 0.8];
    const addBox = (x0: number, z0: number) => {
      const x1 = x0 + cell, z1 = z0 + cell, y0 = y, y1 = y + thick;
      const faces = [
        [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
        [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
        [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
        [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
        [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]],
      ];
      for (let f = 0; f < faces.length; f++) {
        const base = pos.length / 3;
        for (const v of faces[f]) {
          pos.push(v[0], v[1], v[2]);
          const s = shade[f];
          col.push(s, s, s);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = noise.fbm2(i / 7.5, j / 7.5, 3);
        if (v > 0.22) addBox(i * cell - half, j * cell - half);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      // depthWrite: 云块自身的前脸遮住后方的侧面/顶面，消除“华夫格”状多层叠加，
      // 云因此读成有厚度的体素板；云位于世界最高层之上，不影响任何地形通道的深度关系
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.82, fog: false, depthWrite: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -5;
    return mesh;
  }

  /** 由外部（main 的 ui 系统）每帧写入：相机没入水中时切换水下大气表现 */
  setUnderwater(v: boolean) {
    this.submerged = v;
  }

  /** 太阳方向（单位向量） */
  sunDirection(out: THREE.Vector3): THREE.Vector3 {
    const theta = (this.dayTime - 0.25) * Math.PI * 2;
    return out.set(Math.cos(theta), Math.sin(theta), 0.28).normalize();
  }

  timeString(): string {
    const total = this.dayTime * 24 * 60;
    const h = Math.floor(total / 60) % 24;
    const m = Math.floor(total % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt: number, _elapsed: number) {
    this.localTime += dt;
    const elapsed = this.localTime;
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    const sunDir = this.sunDirection(this.tmpSunDir);
    const elev = sunDir.y;
    this.daylight = smoothstep(-0.14, 0.16, elev);
    const dusk = clamp(1 - Math.abs(elev) / 0.32, 0, 1);
    // 水下强度：指数趋近目标值，约 0.2s 完成过渡，避免入/出水瞬间硬切
    const subTarget = this.submerged ? 1 : 0;
    this.sub += (subTarget - this.sub) * Math.min(1, dt * 8);
    if (Math.abs(this.sub - subTarget) < 0.005) this.sub = subTarget;
    const sub = this.sub;

    this.tmpTop.copy(this.cNightTop).lerp(this.cDayTop, this.daylight);
    this.tmpHorizon.copy(this.cNightHorizon).lerp(this.cDayHorizon, this.daylight);
    this.tmpHorizon.lerp(this.cDusk, dusk * 0.75);
    this.tmpTop.lerp(this.cDuskTop, dusk * 0.25);

    const u = this.domeMat.uniforms;
    (u.uTop.value as THREE.Color).copy(this.tmpTop);
    (u.uHorizon.value as THREE.Color).copy(this.tmpHorizon);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    u.uDaylight.value = this.daylight;
    u.uSub.value = sub * 0.85;
    this.tmpSun.set(0xfff2c0).lerp(this.cSunset, dusk);
    (u.uSunColor.value as THREE.Color).copy(this.tmpSun);
    this.sunTint.copy(this.tmpSun);

    // 跟随相机
    this.group.position.copy(this.camera.position);
    this.sun.position.copy(sunDir).multiplyScalar(400);
    this.sun.lookAt(this.group.position);
    this.moon.position.copy(sunDir).multiplyScalar(-400);
    this.moon.lookAt(this.group.position);
    this.starMat.opacity = (1 - this.daylight) * 0.9;
    this.stars.rotation.y = elapsed * 0.004;

    // 云漂移（围绕玩家缓慢平移）
    const cam = this.camera.position;
    if (Math.abs(cam.x - this.cloudBaseX) > 96) this.cloudBaseX = cam.x;
    if (Math.abs(cam.z - this.cloudBaseZ) > 96) this.cloudBaseZ = cam.z;
    this.clouds.position.set(
      this.cloudBaseX - this.group.position.x + elapsed * 1.3,
      -this.group.position.y,
      this.cloudBaseZ - this.group.position.z,
    );
    const cloudMat = this.clouds.material as THREE.MeshBasicMaterial;
    // 日落/日出时把云染向霞光色，夜里压暗；水下淡出以免穿帮
    cloudMat.color.copy(this.tmpHorizon).lerp(this.cWhite, 0.35 + this.daylight * 0.45);
    cloudMat.color.lerp(this.tmpSun, dusk * 0.25);
    cloudMat.color.multiplyScalar(0.45 + this.daylight * 0.55);
    cloudMat.opacity = (0.32 + this.daylight * 0.5) * (1 - sub * 0.9);
    this.clouds.visible = sub < 0.99;

    // 雾：水下切换为近距蓝雾；世界亮度由区块 shader 的天空光 / 方块光分别处理
    const R = this.getRenderDistance() * 16;
    this.fog.color.copy(this.tmpHorizon).lerp(this.cUnderFog, sub);
    this.fog.near = lerp(R * 0.55, 2, sub);
    this.fog.far = lerp(R * 0.98, R * 0.42, sub);

    // 实体光照
    this.sunLight.position.copy(cam).addScaledVector(sunDir, 120);
    this.sunLight.target.position.copy(cam);
    this.sunLight.intensity = 0.18 + this.daylight * 1.0;
    this.sunLight.color.set(0xffffff).lerp(this.cWarm, dusk * 0.8);
    this.hemi.intensity = 0.32 + this.daylight * 0.5;
    this.hemi.color.copy(this.tmpTop).lerp(this.cWhite, 0.4);

    this.emitAcc += dt;
    if (this.emitAcc > 0.5) {
      this.emitAcc = 0;
      this.events.emit('time:change', { dayTime: this.dayTime, daylight: this.daylight });
    }
  }
}

function makeSunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fdf6c3';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#fffbe0';
  ctx.fillRect(2, 2, 12, 12);
  ctx.fillStyle = '#f5e9a8';
  for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) ctx.clearRect(x, y, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeMoonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d8dde2';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#b8bfc8';
  for (const [x, y, s] of [[3, 4, 3], [9, 2, 2], [10, 9, 3], [5, 11, 2], [12, 5, 2]]) ctx.fillRect(x, y, s, s);
  ctx.fillStyle = '#eef1f4';
  ctx.fillRect(2, 2, 4, 3);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}