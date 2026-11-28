export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipReadOptions {
  filter?: (name: string) => boolean;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DEFAULT_MAX_ENTRIES = 256;
/** 防御恶意中央目录的硬上限；真实 Java / Bedrock 资源包可能含有数千个声音 / 模型文件 */
const MAX_RAW_ENTRIES = 20_000;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

function findEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (u32(view, i) === EOCD) return i;
  }
  return -1;
}

async function inflateRaw(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 deflate 解压，请使用未压缩 ZIP 或直接导入 PNG');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('ZIP 解压后文件超过限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readZip(buffer: ArrayBuffer, options: ZipReadOptions = {}): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) throw new Error('不是有效的 ZIP 文件');
  const count = u16(view, end + 10);
  const dirOffset = u32(view, end + 16);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (count > MAX_RAW_ENTRIES) throw new Error('ZIP 中央目录条目过多');
  if (dirOffset < 0 || dirOffset >= view.byteLength) throw new Error('ZIP 中央目录损坏');

  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let p = dirOffset;
  let total = 0;
  // 上限只数实际读取的条目：过滤掉声音 / 模型等非纹理文件后，资源包本身可以很大
  let accepted = 0;
  for (let i = 0; i < count; i++) {
    if (u32(view, p) !== CENTRAL) throw new Error('ZIP 中央目录条目损坏');
    const flags = u16(view, p + 8);
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const uncompressedSize = u32(view, p + 24);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > view.byteLength || localOffset >= view.byteLength) throw new Error('ZIP 条目越界');
    p = next;
    if (name.endsWith('/')) continue;
    if (options.filter && !options.filter(name)) continue;
    if (++accepted > maxEntries) throw new Error(`ZIP 纹理条目过多，最多支持 ${maxEntries} 个文件`);
    if (flags & 1) throw new Error(`不支持加密 ZIP 条目：${name}`);
    if (uncompressedSize > maxEntryBytes) throw new Error(`ZIP 单文件过大：${name}`);
    if (total + uncompressedSize > maxTotalBytes) throw new Error('ZIP 解压总量超过限制');
    if (method === 8 && uncompressedSize > 0 && compressedSize > 0 &&
      uncompressedSize / compressedSize > 200) {
      throw new Error(`ZIP 压缩比异常：${name}`);
    }
    if (u32(view, localOffset) !== LOCAL) throw new Error(`ZIP 本地头损坏：${name}`);
    const localNameLen = u16(view, localOffset + 26);
    const localExtraLen = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > view.byteLength) throw new Error(`ZIP 数据越界：${name}`);
    const raw = new Uint8Array(buffer, dataStart, compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw, maxEntryBytes);
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
    if (data.byteLength > maxEntryBytes) throw new Error(`ZIP 解压后文件过大：${name}`);
    total += data.byteLength;
    if (total > maxTotalBytes) throw new Error('ZIP 解压总量超过限制');
    out.set(name, data);
  }
  return out;
}