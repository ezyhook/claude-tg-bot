// OGG/Opus (Telegram voice) -> 16 kHz mono 16-bit WAV for whisper.cpp, without ffmpeg.
// Usage: node decode.mjs <in.ogg> <out.wav>
import { readFileSync, writeFileSync } from "node:fs";
import { OggOpusDecoder } from "ogg-opus-decoder";

const [inPath, outPath] = process.argv.slice(2);
const decoder = new OggOpusDecoder();
await decoder.ready;
const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(readFileSync(inPath)));
decoder.free();

// mix down to mono
const n = channelData[0].length;
const mono = new Float32Array(n);
for (const ch of channelData) for (let i = 0; i < n; i++) mono[i] += ch[i] / channelData.length;

// resample to 16 kHz: average over each output sample's input span (a simple low-pass, fine for speech)
const ratio = sampleRate / 16000, outLen = Math.floor(n / ratio);
const pcm = new Int16Array(outLen);
for (let j = 0; j < outLen; j++) {
  const a = Math.floor(j * ratio), b = Math.max(a + 1, Math.floor((j + 1) * ratio));
  let s = 0;
  for (let i = a; i < b; i++) s += mono[i];
  pcm[j] = Math.max(-1, Math.min(1, s / (b - a))) * 32767;
}

const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
writeFileSync(outPath, Buffer.concat([header, Buffer.from(pcm.buffer)]));
