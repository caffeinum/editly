import assert from "assert";
import { createCanvas, ImageData, registerFont } from "canvas";
import { compareVersions } from "compare-versions";
import { execa } from "execa";
import * as fabric$1 from "fabric/node";
import { FabricImage, FabricText, Gradient, Rect, Textbox } from "fabric/node";
import fileUrl from "file-url";
import fsExtra, { pathExists } from "fs-extra";
import GL from "gl";
import createBuffer from "gl-buffer";
import createShader from "gl-shader";
import createTexture from "gl-texture2d";
import glTransition from "gl-transition";
import glTransitions from "gl-transitions";
import JSON5 from "json5";
import { flatMap, merge, sortBy } from "lodash-es";
import flatMap$1 from "lodash-es/flatMap.js";
import { nanoid } from "nanoid";
import ndarray from "ndarray";
import { readFile } from "node:fs/promises";
import pMap from "p-map";
import { basename, dirname as dirname$1, join, resolve } from "path";
import { Transform } from "stream";
import { fileURLToPath } from "url";

const config = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  enableFfmpegLog: false,
};
function getFfmpegCommonArgs() {
  return ["-hide_banner", ...(config.enableFfmpegLog ? [] : ["-loglevel", "error"])];
}
function getCutFromArgs({ cutFrom }) {
  return cutFrom ? ["-ss", cutFrom.toString()] : [];
}
async function testFf(exePath, name) {
  const minRequiredVersion = "4.3.1";
  try {
    const { stdout } = await execa(exePath, ["-version"]);
    const firstLine = stdout.split("\n")[0];
    const match = firstLine.match(`${name} version ([0-9.]+)`);
    assert(match, "Unknown version string");
    const versionStr = match[1];
    console.log(`${name} version ${versionStr}`);
    assert(compareVersions(versionStr, minRequiredVersion), "Version is outdated");
  } catch (err) {
    console.error(`WARNING: ${name}:`, err);
  }
}
async function configureFf(params) {
  Object.assign(config, params);
  await testFf(config.ffmpegPath, "ffmpeg");
  await testFf(config.ffprobePath, "ffprobe");
}
function ffmpeg(args, options) {
  if (config.enableFfmpegLog) console.log(`$ ${config.ffmpegPath} ${args.join(" ")}`);
  return execa(config.ffmpegPath, [...getFfmpegCommonArgs(), ...args], options);
}
function ffprobe(args) {
  return execa(config.ffprobePath, args);
}
function parseFps(fps) {
  const match = typeof fps === "string" && fps.match(/^([0-9]+)\/([0-9]+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const den = parseInt(match[2], 10);
    if (den > 0) return num / den;
  }
  return void 0;
}
async function readDuration(p) {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    p,
  ]);
  const parsed = parseFloat(stdout);
  assert(!Number.isNaN(parsed));
  return parsed;
}
async function readFileStreams(p) {
  const { stdout } = await ffprobe(["-show_entries", "stream", "-of", "json", p]);
  return JSON.parse(stdout).streams;
}
async function readVideoFileInfo(p) {
  const streams = await readFileStreams(p);
  const stream = streams.find((s) => s.codec_type === "video");
  if (!stream) {
    throw new Error(`Could not find a video stream in ${p}`);
  }
  const duration = await readDuration(p);
  let rotation = parseInt(stream.tags?.rotate ?? "", 10);
  if (Number.isNaN(rotation) && stream.side_data_list?.[0]?.rotation) {
    rotation = parseInt(stream.side_data_list[0].rotation, 10);
  }
  return {
    // numFrames: parseInt(stream.nb_frames, 10),
    duration,
    width: stream.width,
    // TODO coded_width?
    height: stream.height,
    framerateStr: stream.r_frame_rate,
    rotation: !Number.isNaN(rotation) ? rotation : void 0,
  };
}

var Audio = ({ verbose, tmpDir }) => {
  async function createMixedAudioClips({ clips, keepSourceAudio }) {
    return pMap(
      clips,
      async (clip, i) => {
        const { duration, layers, transition } = clip;
        async function runInner() {
          const clipAudioPath2 = join(tmpDir, `clip${i}-audio.flac`);
          async function createSilence() {
            if (verbose) console.log("create silence", duration);
            const args2 = [
              "-nostdin",
              "-f",
              "lavfi",
              "-i",
              "anullsrc=channel_layout=stereo:sample_rate=44100",
              "-sample_fmt",
              "s32",
              "-ar",
              "48000",
              "-t",
              duration.toString(),
              "-c:a",
              "flac",
              "-y",
              clipAudioPath2,
            ];
            await ffmpeg(args2);
            return { silent: true, clipAudioPath: clipAudioPath2 };
          }
          if (!keepSourceAudio) return createSilence();
          const audioLayers = layers.filter(
            ({ type, start, stop }) =>
              ["audio", "video"].includes(type) && // TODO: We don't support audio for start/stop layers
              !start &&
              stop == null,
          );
          if (audioLayers.length === 0) return createSilence();
          const processedAudioLayersRaw = await pMap(
            audioLayers,
            async (audioLayer, j) => {
              const { path, cutFrom, cutTo, speedFactor } = audioLayer;
              const streams = await readFileStreams(path);
              if (!streams.some((s) => s.codec_type === "audio")) return void 0;
              const layerAudioPath = join(tmpDir, `clip${i}-layer${j}-audio.flac`);
              try {
                let atempoFilter;
                if (Math.abs(speedFactor - 1) > 0.01) {
                  if (verbose) console.log("audio speedFactor", speedFactor);
                  const atempo = 1 / speedFactor;
                  if (!(atempo >= 0.5 && atempo <= 100)) {
                    console.warn(
                      `Audio speed ${atempo} is outside accepted range, using silence (clip ${i})`,
                    );
                    return void 0;
                  }
                  atempoFilter = `atempo=${atempo}`;
                }
                const cutToArg = (cutTo - cutFrom) * speedFactor;
                const args2 = [
                  "-nostdin",
                  ...getCutFromArgs({ cutFrom }),
                  "-i",
                  path,
                  "-t",
                  cutToArg.toString(),
                  "-sample_fmt",
                  "s32",
                  "-ar",
                  "48000",
                  "-map",
                  "a:0",
                  "-c:a",
                  "flac",
                  ...(atempoFilter ? ["-filter:a", atempoFilter] : []),
                  "-y",
                  layerAudioPath,
                ];
                await ffmpeg(args2);
                return [layerAudioPath, audioLayer];
              } catch (err) {
                if (verbose) console.error("Cannot extract audio from video", path, err);
                return void 0;
              }
            },
            { concurrency: 4 },
          );
          const processedAudioLayers = processedAudioLayersRaw.filter((r) => r !== void 0);
          if (processedAudioLayers.length < 1) return createSilence();
          if (processedAudioLayers.length === 1)
            return { clipAudioPath: processedAudioLayers[0][0], silent: false };
          const weights = processedAudioLayers.map(([, { mixVolume }]) => mixVolume ?? 1);
          const args = [
            "-nostdin",
            ...flatMap(processedAudioLayers, ([layerAudioPath]) => ["-i", layerAudioPath]),
            "-filter_complex",
            `amix=inputs=${processedAudioLayers.length}:duration=longest:weights=${weights.join(" ")}`,
            "-c:a",
            "flac",
            "-y",
            clipAudioPath2,
          ];
          await ffmpeg(args);
          return { clipAudioPath: clipAudioPath2, silent: false };
        }
        const { clipAudioPath, silent } = await runInner();
        return {
          path: resolve(clipAudioPath),
          // https://superuser.com/a/853262/658247
          transition,
          silent,
        };
      },
      { concurrency: 4 },
    );
  }
  async function crossFadeConcatClipAudio(clipAudio) {
    if (clipAudio.length < 2) {
      return clipAudio[0].path;
    }
    const outPath = join(tmpDir, "audio-concat.flac");
    if (verbose)
      console.log(
        "Combining audio",
        clipAudio.map(({ path }) => basename(path)),
      );
    let inStream = "[0:a]";
    const filterGraph = clipAudio
      .slice(0, -1)
      .map(({ transition }, i) => {
        const outStream = `[concat${i}]`;
        const epsilon = 1e-4;
        let ret = `${inStream}[${i + 1}:a]acrossfade=d=${Math.max(epsilon, transition?.duration ?? 0)}:c1=${transition?.audioOutCurve ?? "tri"}:c2=${transition?.audioInCurve ?? "tri"}`;
        inStream = outStream;
        if (i < clipAudio.length - 2) ret += outStream;
        return ret;
      })
      .join(",");
    const args = [
      "-nostdin",
      ...flatMap(clipAudio, ({ path }) => ["-i", path]),
      "-filter_complex",
      filterGraph,
      "-c",
      "flac",
      "-y",
      outPath,
    ];
    await ffmpeg(args);
    return outPath;
  }
  async function mixArbitraryAudio({ streams, audioNorm, outputVolume }) {
    let maxGain = 30;
    let gaussSize = 5;
    if (audioNorm) {
      if (audioNorm.gaussSize != null) gaussSize = audioNorm.gaussSize;
      if (audioNorm.maxGain != null) maxGain = audioNorm.maxGain;
    }
    const enableAudioNorm = audioNorm && audioNorm.enable;
    let filterComplex = streams
      .map(({ start, cutFrom, cutTo }, i) => {
        const cutToArg = cutTo != null ? `:end=${cutTo}` : "";
        const apadArg = i > 0 ? ",apad" : "";
        return `[${i}:a]atrim=start=${cutFrom || 0}${cutToArg},adelay=delays=${Math.floor((start || 0) * 1e3)}:all=1${apadArg}[a${i}]`;
      })
      .join(";");
    const volumeArg = outputVolume != null ? `,volume=${outputVolume}` : "";
    const audioNormArg = enableAudioNorm ? `,dynaudnorm=g=${gaussSize}:maxgain=${maxGain}` : "";
    filterComplex += `;${streams.map((_, i) => `[a${i}]`).join("")}amix=inputs=${streams.length}:duration=first:dropout_transition=0:weights=${streams.map((s) => (s.mixVolume != null ? s.mixVolume : 1)).join(" ")}${audioNormArg}${volumeArg}`;
    const mixedAudioPath = join(tmpDir, "audio-mixed.flac");
    const args = [
      "-nostdin",
      ...flatMap(streams, ({ path, loop }) => ["-stream_loop", (loop || 0).toString(), "-i", path]),
      "-vn",
      "-filter_complex",
      filterComplex,
      "-c:a",
      "flac",
      "-y",
      mixedAudioPath,
    ];
    await ffmpeg(args);
    return mixedAudioPath;
  }
  async function editAudio({
    keepSourceAudio,
    clips,
    arbitraryAudio,
    clipsAudioVolume,
    audioNorm,
    outputVolume,
  }) {
    if (clips.length === 0) return void 0;
    if (!(keepSourceAudio || arbitraryAudio.length > 0)) return void 0;
    console.log("Extracting audio/silence from all clips");
    const clipAudio = await createMixedAudioClips({ clips, keepSourceAudio });
    if (clipAudio.every((ca) => ca.silent) && arbitraryAudio.length === 0) return void 0;
    const concatedClipAudioPath = await crossFadeConcatClipAudio(clipAudio);
    const streams = [
      // The first stream is required, as it determines the length of the output audio.
      // All other streams will be truncated to its length
      { path: concatedClipAudioPath, mixVolume: clipsAudioVolume },
      ...arbitraryAudio,
    ];
    console.log("Mixing clip audio with arbitrary audio");
    if (streams.length < 2) return concatedClipAudioPath;
    const mixedFile = await mixArbitraryAudio({ streams, audioNorm, outputVolume });
    return mixedFile;
  }
  return {
    editAudio,
  };
};

function defineFrameSource(type, setup) {
  return {
    type,
    async setup(options) {
      return new FrameSource(options, await setup(options));
    },
  };
}
class FrameSource {
  options;
  implementation;
  constructor(options, implementation) {
    this.options = options;
    this.implementation = implementation;
  }
  async readNextFrame(time, canvas) {
    const { start, layerDuration } = this.layer;
    const offsetTime = time - (start ?? 0);
    const offsetProgress = offsetTime / layerDuration;
    const shouldDrawLayer = offsetProgress >= 0 && offsetProgress <= 1;
    if (!shouldDrawLayer) return;
    return await this.implementation.readNextFrame(offsetProgress, canvas, offsetTime);
  }
  async close() {
    await this.implementation.close?.();
  }
  get layer() {
    return this.options.params;
  }
}

var mul_table = [
  1, 57, 41, 21, 203, 34, 97, 73, 227, 91, 149, 62, 105, 45, 39, 137, 241, 107, 3, 173, 39, 71, 65,
  238, 219, 101, 187, 87, 81, 151, 141, 133, 249, 117, 221, 209, 197, 187, 177, 169, 5, 153, 73,
  139, 133, 127, 243, 233, 223, 107, 103, 99, 191, 23, 177, 171, 165, 159, 77, 149, 9, 139, 135,
  131, 253, 245, 119, 231, 224, 109, 211, 103, 25, 195, 189, 23, 45, 175, 171, 83, 81, 79, 155, 151,
  147, 9, 141, 137, 67, 131, 129, 251, 123, 30, 235, 115, 113, 221, 217, 53, 13, 51, 50, 49, 193,
  189, 185, 91, 179, 175, 43, 169, 83, 163, 5, 79, 155, 19, 75, 147, 145, 143, 35, 69, 17, 67, 33,
  65, 255, 251, 247, 243, 239, 59, 29, 229, 113, 111, 219, 27, 213, 105, 207, 51, 201, 199, 49, 193,
  191, 47, 93, 183, 181, 179, 11, 87, 43, 85, 167, 165, 163, 161, 159, 157, 155, 77, 19, 75, 37, 73,
  145, 143, 141, 35, 138, 137, 135, 67, 33, 131, 129, 255, 63, 250, 247, 61, 121, 239, 237, 117, 29,
  229, 227, 225, 111, 55, 109, 216, 213, 211, 209, 207, 205, 203, 201, 199, 197, 195, 193, 48, 190,
  47, 93, 185, 183, 181, 179, 178, 176, 175, 173, 171, 85, 21, 167, 165, 41, 163, 161, 5, 79, 157,
  78, 154, 153, 19, 75, 149, 74, 147, 73, 144, 143, 71, 141, 140, 139, 137, 17, 135, 134, 133, 66,
  131, 65, 129, 1,
];
var shg_table = [
  0, 9, 10, 10, 14, 12, 14, 14, 16, 15, 16, 15, 16, 15, 15, 17, 18, 17, 12, 18, 16, 17, 17, 19, 19,
  18, 19, 18, 18, 19, 19, 19, 20, 19, 20, 20, 20, 20, 20, 20, 15, 20, 19, 20, 20, 20, 21, 21, 21,
  20, 20, 20, 21, 18, 21, 21, 21, 21, 20, 21, 17, 21, 21, 21, 22, 22, 21, 22, 22, 21, 22, 21, 19,
  22, 22, 19, 20, 22, 22, 21, 21, 21, 22, 22, 22, 18, 22, 22, 21, 22, 22, 23, 22, 20, 23, 22, 22,
  23, 23, 21, 19, 21, 21, 21, 23, 23, 23, 22, 23, 23, 21, 23, 22, 23, 18, 22, 23, 20, 22, 23, 23,
  23, 21, 22, 20, 22, 21, 22, 24, 24, 24, 24, 24, 22, 21, 24, 23, 23, 24, 21, 24, 23, 24, 22, 24,
  24, 22, 24, 24, 22, 23, 24, 24, 24, 20, 23, 22, 23, 24, 24, 24, 24, 24, 24, 24, 23, 21, 23, 22,
  23, 24, 24, 24, 22, 24, 24, 24, 23, 22, 24, 24, 25, 23, 25, 25, 23, 24, 25, 25, 24, 22, 25, 25,
  25, 24, 23, 24, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 23, 25, 23, 24, 25, 25, 25, 25,
  25, 25, 25, 25, 25, 24, 22, 25, 25, 23, 25, 25, 20, 24, 25, 24, 25, 25, 22, 24, 25, 24, 25, 24,
  25, 25, 24, 25, 25, 25, 25, 22, 25, 25, 25, 24, 25, 24, 25, 18,
];
function boxBlurImage(context, width, height, radius, blurAlphaChannel, iterations) {
  if (isNaN(radius) || radius < 1) return;
  {
    boxBlurCanvasRGB(context, 0, 0, width, height, radius, iterations);
  }
}
function boxBlurCanvasRGB(context, top_x, top_y, width, height, radius, iterations) {
  if (isNaN(radius) || radius < 1) return;
  radius |= 0;
  if (isNaN(iterations)) iterations = 1;
  iterations |= 0;
  if (iterations > 3) iterations = 3;
  if (iterations < 1) iterations = 1;
  var imageData;
  try {
    imageData = context.getImageData(top_x, top_y, width, height);
  } catch (e) {
    alert("Cannot access image");
    throw new Error("unable to access image data: " + e);
  }
  var pixels = imageData.data;
  var rsum, gsum, bsum, x, y, i, p, p1, p2, yp, yi, yw;
  var wm = width - 1;
  var hm = height - 1;
  var rad1 = radius + 1;
  var r = [];
  var g = [];
  var b = [];
  var mul_sum = mul_table[radius];
  var shg_sum = shg_table[radius];
  var vmin = [];
  var vmax = [];
  while (iterations-- > 0) {
    yw = yi = 0;
    for (y = 0; y < height; y++) {
      rsum = pixels[yw] * rad1;
      gsum = pixels[yw + 1] * rad1;
      bsum = pixels[yw + 2] * rad1;
      for (i = 1; i <= radius; i++) {
        p = yw + ((i > wm ? wm : i) << 2);
        rsum += pixels[p++];
        gsum += pixels[p++];
        bsum += pixels[p++];
      }
      for (x = 0; x < width; x++) {
        r[yi] = rsum;
        g[yi] = gsum;
        b[yi] = bsum;
        if (y == 0) {
          vmin[x] = ((p = x + rad1) < wm ? p : wm) << 2;
          vmax[x] = (p = x - radius) > 0 ? p << 2 : 0;
        }
        p1 = yw + vmin[x];
        p2 = yw + vmax[x];
        rsum += pixels[p1++] - pixels[p2++];
        gsum += pixels[p1++] - pixels[p2++];
        bsum += pixels[p1++] - pixels[p2++];
        yi++;
      }
      yw += width << 2;
    }
    for (x = 0; x < width; x++) {
      yp = x;
      rsum = r[yp] * rad1;
      gsum = g[yp] * rad1;
      bsum = b[yp] * rad1;
      for (i = 1; i <= radius; i++) {
        yp += i > hm ? 0 : width;
        rsum += r[yp];
        gsum += g[yp];
        bsum += b[yp];
      }
      yi = x << 2;
      for (y = 0; y < height; y++) {
        pixels[yi] = (rsum * mul_sum) >>> shg_sum;
        pixels[yi + 1] = (gsum * mul_sum) >>> shg_sum;
        pixels[yi + 2] = (bsum * mul_sum) >>> shg_sum;
        if (x == 0) {
          vmin[y] = ((p = y + rad1) < hm ? p : hm) * width;
          vmax[y] = (p = y - radius) > 0 ? p * width : 0;
        }
        p1 = x + vmin[y];
        p2 = x + vmax[y];
        rsum += r[p1] - r[p2];
        gsum += g[p1] - g[p2];
        bsum += b[p1] - b[p2];
        yi += width << 2;
      }
    }
  }
  context.putImageData(imageData, top_x, top_y);
}

function canvasToRgba(ctx) {
  const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  return Buffer.from(imageData.data);
}
function fabricCanvasToRgba(fabricCanvas) {
  const internalCanvas = fabricCanvas.getNodeCanvas();
  const ctx = internalCanvas.getContext("2d");
  return canvasToRgba(ctx);
}
function createFabricCanvas({ width, height }) {
  return new fabric$1.StaticCanvas(null, { width, height });
}
async function renderFabricCanvas(canvas) {
  canvas.renderAll();
  const rgba = fabricCanvasToRgba(canvas);
  canvas.clear();
  canvas.dispose();
  return rgba;
}
function toUint8ClampedArray(buffer) {
  const data = new Uint8ClampedArray(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    data[i] = buffer[i];
  }
  return data;
}
async function rgbaToFabricImage({ width, height, rgba }) {
  const canvas = createCanvas(width, height);
  canvas.classList = /* @__PURE__ */ new Set();
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(toUint8ClampedArray(rgba), width, height), 0, 0);
  return new fabric$1.FabricImage(canvas);
}
async function blurImage({ mutableImg, width, height }) {
  mutableImg.set({ scaleX: width / mutableImg.width, scaleY: height / mutableImg.height });
  const canvas = mutableImg.toCanvasElement();
  const ctx = canvas.getContext("2d");
  const blurAmount = Math.min(100, Math.max(width, height) / 10);
  const passes = 1;
  boxBlurImage(ctx, width, height, blurAmount, false, passes);
  return new fabric$1.FabricImage(canvas);
}
var fabric = defineFrameSource("fabric", async ({ width, height, params }) => {
  const { onRender, onClose } = await params.func({ width, height, fabric: fabric$1, params });
  return {
    readNextFrame: onRender,
    close: onClose,
  };
});

var canvas = defineFrameSource("canvas", async ({ width, height, params }) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const { onClose, onRender } = await params.func({ width, height, canvas });
  async function readNextFrame(progress) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    await onRender(progress);
    return canvasToRgba(context);
  }
  return {
    readNextFrame,
    // Node canvas needs no cleanup https://github.com/Automattic/node-canvas/issues/1216#issuecomment-412390668
    close: onClose,
  };
});

const allColors = [
  "hsl(42, 100%, 50%)",
  "hsl(310, 34%, 37%)",
  "hsl(24, 100%, 50%)",
  "hsl(211, 38%, 74%)",
  "hsl(350, 100%, 37%)",
  "hsl(35, 52%, 59%)",
  "hsl(22, 11%, 45%)",
  "hsl(145, 100%, 24%)",
  "hsl(348, 87%, 71%)",
  "hsl(203, 100%, 27%)",
  "hsl(11, 100%, 68%)",
  "hsl(265, 37%, 34%)",
  "hsl(33, 100%, 50%)",
  "hsl(342, 63%, 42%)",
  "hsl(49, 100%, 47%)",
  "hsl(5, 81%, 27%)",
  "hsl(68, 100%, 33%)",
  "hsl(26, 61%, 21%)",
  "hsl(10, 88%, 51%)",
  "hsl(84, 33%, 12%)",
];
const gradientColors = [
  ["#ff9aac", "#ffa875"],
  ["#cc2b5e", "#753a88"],
  ["#42275a", "#734b6d"],
  ["#bdc3c7", "#2c3e50"],
  ["#de6262", "#ffb88c"],
  ["#eb3349", "#f45c43"],
  ["#dd5e89", "#f7bb97"],
  ["#56ab2f", "#a8e063"],
  ["#614385", "#516395"],
  ["#eecda3", "#ef629f"],
  ["#eacda3", "#d6ae7b"],
  ["#02aab0", "#00cdac"],
  ["#d66d75", "#e29587"],
  ["#000428", "#004e92"],
  ["#ddd6f3", "#faaca8"],
  ["#7b4397", "#dc2430"],
  ["#43cea2", "#185a9d"],
  ["#ba5370", "#f4e2d8"],
  ["#ff512f", "#dd2476"],
  ["#4568dc", "#b06ab3"],
  ["#ec6f66", "#f3a183"],
  ["#ffd89b", "#19547b"],
  ["#3a1c71", "#d76d77"],
  ["#4ca1af", "#c4e0e5"],
  ["#ff5f6d", "#ffc371"],
  ["#36d1dc", "#5b86e5"],
  ["#c33764", "#1d2671"],
  ["#141e30", "#243b55"],
  ["#ff7e5f", "#feb47b"],
  ["#ed4264", "#ffedbc"],
  ["#2b5876", "#4e4376"],
  ["#ff9966", "#ff5e62"],
  ["#aa076b", "#61045f"],
];
function getRandomColor(colors = allColors) {
  const index = Math.floor(Math.random() * colors.length);
  const remainingColors = [...colors];
  remainingColors.splice(index, 1);
  return { remainingColors, color: colors[index] || allColors[0] };
}
function getRandomColors(num) {
  let colors = allColors;
  const out = [];
  for (let i = 0; i < Math.min(num, allColors.length); i += 1) {
    const { remainingColors, color } = getRandomColor(colors);
    out.push(color);
    colors = remainingColors;
  }
  return out;
}
function getRandomGradient() {
  return gradientColors[Math.floor(Math.random() * gradientColors.length)];
}

var fillColor = defineFrameSource("fill-color", async ({ params, width, height }) => {
  const { color } = params;
  const randomColor = getRandomColors(1)[0];
  return {
    async readNextFrame(_, canvas) {
      const rect = new Rect({
        left: 0,
        right: 0,
        width,
        height,
        fill: color || randomColor,
      });
      canvas.add(rect);
    },
  };
});

var gl = defineFrameSource("gl", async ({ width, height, channels, params }) => {
  const gl = GL(width, height);
  const defaultVertexSrc = `
    attribute vec2 position;
    void main(void) {
      gl_Position = vec4(position, 0.0, 1.0 );
    }
  `;
  const {
    vertexPath,
    fragmentPath,
    vertexSrc: vertexSrcIn,
    fragmentSrc: fragmentSrcIn,
    speed = 1,
  } = params;
  let fragmentSrc = fragmentSrcIn;
  let vertexSrc = vertexSrcIn;
  if (fragmentPath) fragmentSrc = (await readFile(fragmentPath)).toString();
  if (vertexPath) vertexSrc = (await readFile(vertexPath)).toString();
  if (!vertexSrc) vertexSrc = defaultVertexSrc;
  const shader = createShader(gl, vertexSrc, fragmentSrc ?? "");
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  async function readNextFrame(progress) {
    shader.bind();
    shader.attributes.position.pointer();
    shader.uniforms.resolution = [width, height];
    shader.uniforms.time = progress * speed;
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    const upsideDownArray = Buffer.allocUnsafe(width * height * channels);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, upsideDownArray);
    const outArray = Buffer.allocUnsafe(width * height * channels);
    for (let i = 0; i < outArray.length; i += 4) {
      outArray[i + 0] = upsideDownArray[outArray.length - i + 0];
      outArray[i + 1] = upsideDownArray[outArray.length - i + 1];
      outArray[i + 2] = upsideDownArray[outArray.length - i + 2];
      outArray[i + 3] = upsideDownArray[outArray.length - i + 3];
    }
    return outArray;
  }
  return {
    readNextFrame,
  };
});

const multipleOf2 = (x) => Math.round(x / 2) * 2;
function getPositionProps({ position, width, height }) {
  let originY = "center";
  let originX = "center";
  let top = height / 2;
  let left = width / 2;
  const margin = 0.05;
  if (typeof position === "string") {
    if (position === "top") {
      originY = "top";
      top = height * margin;
    } else if (position === "bottom") {
      originY = "bottom";
      top = height * (1 - margin);
    } else if (position === "center") {
      originY = "center";
      top = height / 2;
    } else if (position === "top-left") {
      originX = "left";
      originY = "top";
      left = width * margin;
      top = height * margin;
    } else if (position === "top-right") {
      originX = "right";
      originY = "top";
      left = width * (1 - margin);
      top = height * margin;
    } else if (position === "center-left") {
      originX = "left";
      originY = "center";
      left = width * margin;
      top = height / 2;
    } else if (position === "center-right") {
      originX = "right";
      originY = "center";
      left = width * (1 - margin);
      top = height / 2;
    } else if (position === "bottom-left") {
      originX = "left";
      originY = "bottom";
      left = width * margin;
      top = height * (1 - margin);
    } else if (position === "bottom-right") {
      originX = "right";
      originY = "bottom";
      left = width * (1 - margin);
      top = height * (1 - margin);
    }
  } else {
    if (position?.x != null) {
      originX = position.originX || "left";
      left = width * position.x;
    }
    if (position?.y != null) {
      originY = position.originY || "top";
      top = height * position.y;
    }
  }
  return { originX, originY, top, left };
}
function getFrameByKeyFrames(keyframes, progress) {
  if (keyframes.length < 2) throw new Error("Keyframes must be at least 2");
  const sortedKeyframes = sortBy(keyframes, "t");
  const invalidKeyframe = sortedKeyframes.find((k, i) => {
    if (i === 0) return false;
    return k.t === sortedKeyframes[i - 1].t;
  });
  if (invalidKeyframe) throw new Error("Invalid keyframe");
  let prevKeyframe = [...sortedKeyframes].reverse().find((k) => k.t < progress);
  if (!prevKeyframe) prevKeyframe = sortedKeyframes[0];
  let nextKeyframe = sortedKeyframes.find((k) => k.t >= progress);
  if (!nextKeyframe) nextKeyframe = sortedKeyframes[sortedKeyframes.length - 1];
  if (nextKeyframe.t === prevKeyframe.t) return prevKeyframe.props;
  const interProgress = (progress - prevKeyframe.t) / (nextKeyframe.t - prevKeyframe.t);
  return Object.fromEntries(
    Object.entries(prevKeyframe.props).map(([propName, prevVal]) => [
      propName,
      prevVal + (nextKeyframe.props[propName] - prevVal) * interProgress,
    ]),
  );
}
const isUrl = (path) => /^https?:\/\//.test(path);
const assertFileValid = async (path, allowRemoteRequests) => {
  if (isUrl(path)) {
    assert(allowRemoteRequests, "Remote requests are not allowed");
    return;
  }
  assert(await pathExists(path), `File does not exist ${path}`);
};
const loadImage = (pathOrUrl) =>
  fabric$1.util.loadImage(isUrl(pathOrUrl) ? pathOrUrl : fileUrl(pathOrUrl));
const defaultFontFamily = "sans-serif";
function getZoomParams({ progress, zoomDirection, zoomAmount = 0.1 }) {
  let scaleFactor = 1;
  if (zoomDirection === "left" || zoomDirection === "right") return 1.3 + zoomAmount;
  if (zoomDirection === "in") scaleFactor = 1 + zoomAmount * progress;
  else if (zoomDirection === "out") scaleFactor = 1 + zoomAmount * (1 - progress);
  return scaleFactor;
}
function getTranslationParams({ progress, zoomDirection, zoomAmount = 0.1 }) {
  let translation = 0;
  const range = zoomAmount * 1e3;
  if (zoomDirection === "right") translation = progress * range - range / 2;
  else if (zoomDirection === "left") translation = -(progress * range - range / 2);
  return translation;
}
function getRekt(width, height) {
  return new fabric$1.Rect({
    originX: "center",
    originY: "center",
    left: width / 2,
    top: height / 2,
    width: width * 2,
    height: height * 2,
  });
}

var imageOverlay = defineFrameSource("image-overlay", async ({ params, width, height }) => {
  const {
    path,
    position,
    width: relWidth,
    height: relHeight,
    zoomDirection,
    zoomAmount = 0.1,
  } = params;
  const imgData = await loadImage(path);
  const img = new fabric$1.FabricImage(imgData, getPositionProps({ position, width, height }));
  return {
    async readNextFrame(progress, canvas) {
      const scaleFactor = getZoomParams({ progress, zoomDirection, zoomAmount });
      const translationParams = getTranslationParams({ progress, zoomDirection, zoomAmount });
      img.left = width / 2 + translationParams;
      if (relWidth != null) {
        img.scaleToWidth(relWidth * width * scaleFactor);
      } else if (relHeight != null) {
        img.scaleToHeight(relHeight * height * scaleFactor);
      } else {
        img.scaleToWidth(width * scaleFactor);
      }
      canvas.add(img);
    },
  };
});

var image = defineFrameSource("image", async ({ verbose, params, width, height }) => {
  const { path, zoomDirection = "in", zoomAmount = 0.1, resizeMode = "contain-blur" } = params;
  if (verbose) console.log("Loading", path);
  const imgData = await loadImage(path);
  const createImg = () =>
    new FabricImage(imgData, {
      originX: "center",
      originY: "center",
      left: width / 2,
      top: height / 2,
    });
  let blurredImg;
  if (resizeMode === "contain-blur") {
    const mutableImg = createImg();
    if (verbose) console.log("Blurring background");
    blurredImg = await blurImage({ mutableImg, width, height });
  }
  return {
    async readNextFrame(progress, canvas) {
      const img = createImg();
      const scaleFactor = getZoomParams({ progress, zoomDirection, zoomAmount });
      const translationParams = getTranslationParams({ progress, zoomDirection, zoomAmount });
      const ratioW = width / img.width;
      const ratioH = height / img.height;
      img.left = width / 2 + translationParams;
      if (["contain", "contain-blur"].includes(resizeMode)) {
        if (ratioW > ratioH) {
          img.scaleToHeight(height * scaleFactor);
        } else {
          img.scaleToWidth(width * scaleFactor);
        }
      } else if (resizeMode === "cover") {
        if (ratioW > ratioH) {
          img.scaleToWidth(width * scaleFactor);
        } else {
          img.scaleToHeight(height * scaleFactor);
        }
      } else if (resizeMode === "stretch") {
        img.set({
          scaleX: (width / img.width) * scaleFactor,
          scaleY: (height / img.height) * scaleFactor,
        });
      }
      if (blurredImg) canvas.add(blurredImg);
      canvas.add(img);
    },
    close() {
      if (blurredImg) blurredImg.dispose();
    },
  };
});

var linearGradient = defineFrameSource("linear-gradient", async ({ width, height, params }) => {
  const { colors: inColors } = params;
  const colors = inColors && inColors.length === 2 ? inColors : getRandomGradient();
  return {
    async readNextFrame(progress, canvas) {
      const rect = getRekt(width, height);
      rect.set(
        "fill",
        new Gradient({
          coords: {
            x1: 0,
            y1: 0,
            x2: width,
            y2: height,
          },
          colorStops: [
            { offset: 0, color: colors[0] },
            { offset: 1, color: colors[1] },
          ],
        }),
      );
      rect.rotate(progress * 30);
      canvas.add(rect);
    },
  };
});

const easeOutExpo = (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x));
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const linear = (x) => x;

var easings = /*#__PURE__*/ Object.freeze({
  __proto__: null,
  easeInOutCubic: easeInOutCubic,
  easeOutExpo: easeOutExpo,
  linear: linear,
});

var newsTitle = defineFrameSource("news-title", async ({ width, height, params }) => {
  const {
    text,
    textColor = "#ffffff",
    backgroundColor = "#d02a42",
    fontFamily = defaultFontFamily,
    delay = 0,
    speed = 1,
  } = params;
  const min = Math.min(width, height);
  const fontSize = Math.round(min * 0.05);
  return {
    async readNextFrame(progress, canvas) {
      const easedBgProgress = easeOutExpo(Math.max(0, Math.min((progress - delay) * speed * 3, 1)));
      const easedTextProgress = easeOutExpo(
        Math.max(0, Math.min((progress - delay - 0.02) * speed * 4, 1)),
      );
      const easedTextOpacityProgress = easeOutExpo(
        Math.max(0, Math.min((progress - delay - 0.07) * speed * 4, 1)),
      );
      const top = height * 0.08;
      const paddingV = 0.07 * min;
      const paddingH = 0.03 * min;
      const textBox = new FabricText(text, {
        top,
        left: paddingV + (easedTextProgress - 1) * width,
        fill: textColor,
        opacity: easedTextOpacityProgress,
        fontFamily,
        fontSize,
        charSpacing: width * 0.1,
      });
      const bgWidth = textBox.width + paddingV * 2;
      const rect = new Rect({
        top: top - paddingH,
        left: (easedBgProgress - 1) * bgWidth,
        width: bgWidth,
        height: textBox.height + paddingH * 2,
        fill: backgroundColor,
      });
      canvas.add(rect);
      canvas.add(textBox);
    },
  };
});

var radialGradient = defineFrameSource("radial-gradient", async ({ width, height, params }) => {
  const { colors: inColors } = params;
  const colors = inColors && inColors.length === 2 ? inColors : getRandomGradient();
  return {
    async readNextFrame(progress, canvas) {
      const max = Math.max(width, height);
      const r1 = 0;
      const r2 = max * (1 + progress) * 0.6;
      const rect = getRekt(width, height);
      const cx = 0.5 * rect.width;
      const cy = 0.5 * rect.height;
      rect.set(
        "fill",
        new fabric$1.Gradient({
          type: "radial",
          coords: {
            r1,
            r2,
            x1: cx,
            y1: cy,
            x2: cx,
            y2: cy,
          },
          colorStops: [
            { offset: 0, color: colors[0] },
            { offset: 1, color: colors[1] },
          ],
        }),
      );
      canvas.add(rect);
    },
  };
});

var slideInText = defineFrameSource("slide-in-text", async ({ width, height, params }) => {
  const {
    position,
    text,
    fontSize = 0.05,
    charSpacing = 0.1,
    textColor = "#ffffff",
    color = void 0,
    fontFamily = defaultFontFamily,
  } = params;
  if (color) {
    console.warn("slide-in-text: color is deprecated, use textColor.");
  }
  const fontSizeAbs = Math.round(width * fontSize);
  const { left, top, originX, originY } = getPositionProps({ position, width, height });
  return {
    async readNextFrame(progress, canvas) {
      const textBox = new fabric$1.FabricText(text, {
        fill: color ?? textColor,
        fontFamily,
        fontSize: fontSizeAbs,
        charSpacing: width * charSpacing,
      });
      const { opacity, textSlide } = getFrameByKeyFrames(
        [
          { t: 0.1, props: { opacity: 1, textSlide: 0 } },
          { t: 0.3, props: { opacity: 1, textSlide: 1 } },
          { t: 0.8, props: { opacity: 1, textSlide: 1 } },
          { t: 0.9, props: { opacity: 0, textSlide: 1 } },
        ],
        progress,
      );
      const fadedObject = await getFadedObject({
        object: textBox,
        progress: easeInOutCubic(textSlide),
      });
      fadedObject.set({
        originX,
        originY,
        top,
        left,
        opacity,
      });
      canvas.add(fadedObject);
    },
  };
});
async function getFadedObject({ object, progress }) {
  const rect = new fabric$1.Rect({
    left: 0,
    width: object.width,
    height: object.height,
    top: 0,
  });
  rect.set(
    "fill",
    new fabric$1.Gradient({
      coords: {
        x1: 0,
        y1: 0,
        x2: object.width,
        y2: 0,
      },
      colorStops: [
        { offset: Math.max(0, progress * (1 + 0.2) - 0.2), color: "rgba(255,255,255,1)" },
        { offset: Math.min(1, progress * (1 + 0.2)), color: "rgba(255,255,255,0)" },
      ],
    }),
  );
  const gradientMaskImg = rect.cloneAsImage({});
  const fadedImage = object.cloneAsImage({});
  fadedImage.filters.push(
    new fabric$1.filters.BlendImage({
      image: gradientMaskImg,
      mode: "multiply",
    }),
  );
  fadedImage.applyFilters();
  return fadedImage;
}

var subtitle = defineFrameSource("subtitle", async ({ width, height, params }) => {
  const {
    text,
    textColor = "#ffffff",
    backgroundColor = "rgba(0,0,0,0.3)",
    fontFamily = defaultFontFamily,
    delay = 0,
    speed = 1,
  } = params;
  return {
    async readNextFrame(progress, canvas) {
      const easedProgress = easeOutExpo(Math.max(0, Math.min((progress - delay) * speed, 1)));
      const min = Math.min(width, height);
      const padding = 0.05 * min;
      const textBox = new Textbox(text, {
        fill: textColor,
        fontFamily,
        fontSize: min / 20,
        textAlign: "left",
        width: width - padding * 2,
        originX: "center",
        originY: "bottom",
        left: width / 2 + (-1 + easedProgress) * padding,
        top: height - padding,
        opacity: easedProgress,
      });
      const rect = new Rect({
        left: 0,
        width,
        height: textBox.height + padding * 2,
        top: height,
        originY: "bottom",
        fill: backgroundColor,
        opacity: easedProgress,
      });
      canvas.add(rect);
      canvas.add(textBox);
    },
  };
});

var title = defineFrameSource("title", async ({ width, height, params }) => {
  const {
    text,
    textColor = "#ffffff",
    fontFamily = defaultFontFamily,
    position = "center",
    zoomDirection = "in",
    zoomAmount = 0.2,
  } = params;
  const fontSize = Math.round(Math.min(width, height) * 0.1);
  const textBox = new Textbox(text, {
    fill: textColor,
    fontFamily,
    fontSize,
    textAlign: "center",
    width: width * 0.8,
  });
  return {
    async readNextFrame(progress, canvas) {
      const scaleFactor = getZoomParams({ progress, zoomDirection, zoomAmount });
      const translationParams = getTranslationParams({ progress, zoomDirection, zoomAmount });
      const textImage = textBox.cloneAsImage({});
      const { left, top, originX, originY } = getPositionProps({ position, width, height });
      textImage.set({
        originX,
        originY,
        left: left + translationParams,
        top,
        scaleX: scaleFactor,
        scaleY: scaleFactor,
      });
      canvas.add(textImage);
    },
  };
});

function rawVideoToFrames({ width, height, channels, ...options }) {
  const frameByteSize = width * height * channels;
  let buffer = new Uint8Array(frameByteSize);
  let bytesRead = 0;
  return new Transform({
    ...options,
    writableObjectMode: false,
    readableObjectMode: true,
    transform(chunk, _, callback) {
      let startAt = 0;
      while (startAt < chunk.length) {
        const endAt = Math.min(startAt + frameByteSize - bytesRead, chunk.length);
        const bytesToRead = endAt - startAt;
        buffer.set(chunk.slice(startAt, endAt), bytesRead);
        bytesRead = (bytesRead + bytesToRead) % frameByteSize;
        if (bytesRead === 0) {
          this.push(buffer);
          buffer = new Uint8Array(frameByteSize);
        }
        startAt = endAt;
      }
      callback();
    },
  });
}

var video = defineFrameSource("video", async (options) => {
  const {
    width: canvasWidth,
    height: canvasHeight,
    channels,
    framerateStr,
    verbose,
    logTimes,
    params,
  } = options;
  const {
    path,
    cutFrom,
    cutTo,
    resizeMode = "contain-blur",
    speedFactor,
    inputWidth,
    inputHeight,
    width: requestedWidthRel,
    height: requestedHeightRel,
    left: leftRel = 0,
    top: topRel = 0,
    originX = "left",
    originY = "top",
    fabricImagePostProcessing = null,
  } = params;
  const requestedWidth = requestedWidthRel
    ? Math.round(requestedWidthRel * canvasWidth)
    : canvasWidth;
  const requestedHeight = requestedHeightRel
    ? Math.round(requestedHeightRel * canvasHeight)
    : canvasHeight;
  const left = leftRel * canvasWidth;
  const top = topRel * canvasHeight;
  const ratioW = requestedWidth / inputWidth;
  const ratioH = requestedHeight / inputHeight;
  const inputAspectRatio = inputWidth / inputHeight;
  let targetWidth = requestedWidth;
  let targetHeight = requestedHeight;
  let scaleFilter;
  if (["contain", "contain-blur"].includes(resizeMode)) {
    if (ratioW > ratioH) {
      targetHeight = requestedHeight;
      targetWidth = Math.round(requestedHeight * inputAspectRatio);
    } else {
      targetWidth = requestedWidth;
      targetHeight = Math.round(requestedWidth / inputAspectRatio);
    }
    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  } else if (resizeMode === "cover") {
    let scaledWidth;
    let scaledHeight;
    if (ratioW > ratioH) {
      scaledWidth = requestedWidth;
      scaledHeight = Math.round(requestedWidth / inputAspectRatio);
    } else {
      scaledHeight = requestedHeight;
      scaledWidth = Math.round(requestedHeight * inputAspectRatio);
    }
    scaleFilter = `scale=${scaledWidth}:${scaledHeight},crop=${targetWidth}:${targetHeight}`;
  } else {
    scaleFilter = `scale=${targetWidth}:${targetHeight}`;
  }
  if (verbose) console.log(scaleFilter);
  let ptsFilter = "";
  if (speedFactor !== 1) {
    if (verbose) console.log("speedFactor", speedFactor);
    ptsFilter = `setpts=${speedFactor}*PTS,`;
  }
  const streams = await readFileStreams(path);
  const firstVideoStream = streams.find((s) => s.codec_type === "video");
  let inputCodec;
  if (firstVideoStream?.codec_name === "vp8") inputCodec = "libvpx";
  else if (firstVideoStream?.codec_name === "vp9") inputCodec = "libvpx-vp9";
  const args = [
    "-nostdin",
    ...(inputCodec ? ["-vcodec", inputCodec] : []),
    ...(cutFrom ? ["-ss", cutFrom.toString()] : []),
    "-i",
    path,
    ...(cutTo ? ["-t", ((cutTo - cutFrom) * speedFactor).toString()] : []),
    "-vf",
    `${ptsFilter}fps=${framerateStr},${scaleFilter}`,
    "-map",
    "v:0",
    "-vcodec",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-f",
    "image2pipe",
    "-",
  ];
  const controller = new AbortController();
  const transform = rawVideoToFrames({
    width: targetWidth,
    height: targetHeight,
    channels,
    signal: controller.signal,
  });
  const ps = ffmpeg(args, {
    encoding: "buffer",
    buffer: false,
    stdin: "ignore",
    stdout: { transform },
    stderr: process.stderr,
    // ffmpeg doesn't like to stop, force it
    forceKillAfterDelay: 1e3,
    cancelSignal: controller.signal,
  });
  ps.catch((err) => {
    if (!err.isCanceled) throw err;
    if (verbose) console.log("ffmpeg process aborted", path);
  });
  const iterator = ps.iterable();
  async function readNextFrame(progress, canvas, time) {
    const { value: rgba, done } = await iterator.next();
    if (done) {
      if (verbose) console.log(path, "ffmpeg video stream ended");
      return;
    }
    if (!rgba) {
      if (verbose) console.log(path, "No frame data received");
      return;
    }
    if (logTimes) console.time("rgbaToFabricImage");
    const img = await rgbaToFabricImage({
      width: targetWidth,
      height: targetHeight,
      rgba: Buffer.from(rgba),
    });
    if (logTimes) console.timeEnd("rgbaToFabricImage");
    img.set({
      originX,
      originY,
    });
    let centerOffsetX = 0;
    let centerOffsetY = 0;
    if (resizeMode === "contain" || resizeMode === "contain-blur") {
      const dirX = originX === "left" ? 1 : -1;
      const dirY = originY === "top" ? 1 : -1;
      centerOffsetX = (dirX * (requestedWidth - targetWidth)) / 2;
      centerOffsetY = (dirY * (requestedHeight - targetHeight)) / 2;
    }
    img.set({
      left: left + centerOffsetX,
      top: top + centerOffsetY,
    });
    if (resizeMode === "contain-blur") {
      const mutableImg = img.cloneAsImage({});
      const blurredImg = await blurImage({
        mutableImg,
        width: requestedWidth,
        height: requestedHeight,
      });
      blurredImg.set({
        left,
        top,
        originX,
        originY,
      });
      canvas.add(blurredImg);
    }
    if (fabricImagePostProcessing) {
      fabricImagePostProcessing({ image: img, progress, fabric: fabric$1, canvas, time });
    }
    canvas.add(img);
  }
  const close = () => {
    if (verbose) console.log("Close", path);
    if (!ps.exitCode) controller.abort();
  };
  return {
    readNextFrame,
    close,
  };
});

const dirname = fileURLToPath(new URL("..", import.meta.url));
const sources = [
  canvas,
  fabric,
  fillColor,
  gl,
  imageOverlay,
  image,
  linearGradient,
  newsTitle,
  radialGradient,
  slideInText,
  subtitle,
  title,
  video,
];
async function createLayerSource(options) {
  const layer = options.params;
  const source = sources.find(({ type }) => type == layer.type);
  assert(source, `Invalid type ${layer.type}`);
  return await source.setup(options);
}
function expandLayerAliases(params) {
  if (params.type === "editly-banner") {
    return [
      { type: "linear-gradient" },
      { ...params, type: "title", text: "Made with\nEDITLY\nmifi.no" },
    ];
  }
  if (params.type === "title-background") {
    const backgroundTypes = ["radial-gradient", "linear-gradient", "fill-color"];
    const {
      background = { type: backgroundTypes[Math.floor(Math.random() * backgroundTypes.length)] },
      ...title2
    } = params;
    return [background, { ...title2, type: "title" }];
  }
  if (params.type === "pause") {
    return [{ ...params, type: "fill-color" }];
  }
  if (params.type === "rainbow-colors") {
    return [{ type: "gl", fragmentPath: join(dirname, "shaders/rainbow-colors.frag") }];
  }
  return [params];
}

const globalDefaults = {
  duration: 4,
  transition: {
    duration: 0.5,
    name: "random",
    audioOutCurve: "tri",
    audioInCurve: "tri",
  },
};
class Configuration {
  clips;
  outPath;
  tmpDir;
  allowRemoteRequests;
  customOutputArgs;
  defaults;
  // Video
  width;
  height;
  fps;
  // Audio
  audioFilePath;
  backgroundAudioVolume;
  loopAudio;
  keepSourceAudio;
  audioNorm;
  outputVolume;
  clipsAudioVolume;
  audioTracks;
  // Debug
  enableFfmpegLog;
  verbose;
  logTimes;
  keepTmp;
  fast;
  ffmpegPath;
  ffprobePath;
  constructor(input) {
    assert(input.outPath, "Please provide an output path");
    assert(Array.isArray(input.clips) && input.clips.length > 0, "Please provide at least 1 clip");
    assert(
      !input.customOutputArgs || Array.isArray(input.customOutputArgs),
      "customOutputArgs must be an array of arguments",
    );
    this.outPath = input.outPath;
    this.width = input.width;
    this.height = input.height;
    this.fps = input.fps;
    this.audioFilePath = input.audioFilePath;
    this.backgroundAudioVolume = input.backgroundAudioVolume;
    this.loopAudio = input.loopAudio;
    this.clipsAudioVolume = input.clipsAudioVolume ?? 1;
    this.audioTracks = input.audioTracks ?? [];
    this.keepSourceAudio = input.keepSourceAudio;
    this.allowRemoteRequests = input.allowRemoteRequests ?? false;
    this.audioNorm = input.audioNorm;
    this.outputVolume = input.outputVolume;
    this.customOutputArgs = input.customOutputArgs;
    this.defaults = merge({}, globalDefaults, input.defaults);
    this.clips = input.clips.map((clip) => {
      let { layers } = clip;
      if (layers && !Array.isArray(layers)) layers = [layers];
      assert(
        Array.isArray(layers) && layers.length > 0,
        "clip.layers must be an array with at least one layer.",
      );
      layers = layers
        .map(expandLayerAliases)
        .flat()
        .map((layer) => {
          assert(layer.type, 'All "layers" must have a type');
          return merge(
            {},
            this.defaults.layer ?? {},
            this.defaults.layerType?.[layer.type] ?? {},
            layer,
          );
        });
      const { transition } = merge({}, this.defaults, clip);
      assert(transition == null || typeof transition === "object", "Transition must be an object");
      return { transition, layers, duration: clip.duration };
    });
    this.verbose = input.verbose ?? false;
    this.enableFfmpegLog = input.enableFfmpegLog ?? this.verbose;
    this.logTimes = input.logTimes ?? false;
    this.keepTmp = input.keepTmp ?? false;
    this.fast = input.fast ?? false;
    this.ffmpegPath = input.ffmpegPath ?? "ffmpeg";
    this.ffprobePath = input.ffprobePath ?? "ffprobe";
    this.tmpDir = join(this.outDir, `editly-tmp-${nanoid()}`);
  }
  get outDir() {
    return dirname$1(this.outPath);
  }
  get isGif() {
    return this.outPath.toLowerCase().endsWith(".gif");
  }
}

async function createFrameSource({
  clip,
  clipIndex,
  width,
  height,
  channels,
  verbose,
  logTimes,
  framerateStr,
}) {
  const { layers, duration } = clip;
  const visualLayers = layers.filter((layer) => layer.type !== "audio");
  const layerFrameSources = await pMap(
    visualLayers,
    async (layer, layerIndex) => {
      if (verbose)
        console.log("createFrameSource", layer.type, "clip", clipIndex, "layer", layerIndex);
      const options = {
        width,
        height,
        duration,
        channels,
        verbose,
        logTimes,
        framerateStr,
        params: layer,
      };
      return createLayerSource(options);
    },
    { concurrency: 1 },
  );
  async function readNextFrame({ time }) {
    const canvas = createFabricCanvas({ width, height });
    for (const frameSource of layerFrameSources) {
      if (logTimes) console.time("frameSource.readNextFrame");
      const rgba2 = await frameSource.readNextFrame(time, canvas);
      if (logTimes) console.timeEnd("frameSource.readNextFrame");
      if (rgba2) {
        if (layerFrameSources.length === 1) return rgba2;
        if (logTimes) console.time("rgbaToFabricImage");
        const img = await rgbaToFabricImage({ width, height, rgba: rgba2 });
        if (logTimes) console.timeEnd("rgbaToFabricImage");
        canvas.add(img);
      }
    }
    if (logTimes) console.time("renderFabricCanvas");
    const rgba = await renderFabricCanvas(canvas);
    if (logTimes) console.timeEnd("renderFabricCanvas");
    return rgba;
  }
  async function close() {
    await pMap(layerFrameSources, (frameSource) => frameSource.close?.());
  }
  return {
    readNextFrame,
    close,
  };
}

const { default: createTransition } = glTransition;
const TransitionAliases = {
  "directional-left": { name: "directional", easing: "easeOutExpo", params: { direction: [1, 0] } },
  "directional-right": {
    name: "directional",
    easing: "easeOutExpo",
    params: { direction: [-1, 0] },
  },
  "directional-down": { name: "directional", easing: "easeOutExpo", params: { direction: [0, 1] } },
  "directional-up": { name: "directional", easing: "easeOutExpo", params: { direction: [0, -1] } },
};
const AllTransitions = [...glTransitions.map((t) => t.name), ...Object.keys(TransitionAliases)];
function getRandomTransition() {
  return AllTransitions[Math.floor(Math.random() * AllTransitions.length)];
}
class Transition {
  name;
  duration;
  params;
  easingFunction;
  source;
  constructor(options, isLastClip = false) {
    if (!options || isLastClip) options = { duration: 0 };
    assert(typeof options === "object", "Transition must be an object");
    assert(
      options.duration === 0 || options.name,
      "Please specify transition name or set duration to 0",
    );
    if (options.name === "random") options.name = getRandomTransition();
    const aliasedTransition = options.name && TransitionAliases[options.name];
    if (aliasedTransition) Object.assign(options, aliasedTransition);
    this.duration = options.duration ?? 0;
    this.name = options.name;
    this.params = options.params;
    this.easingFunction =
      options.easing && easings[options.easing] ? easings[options.easing] : linear;
    if (this.name && this.name !== "dummy") {
      this.source = glTransitions.find(
        ({ name }) => name.toLowerCase() === this.name?.toLowerCase(),
      );
      assert(this.source, `Transition not found: ${this.name}`);
    }
  }
  create({ width, height, channels }) {
    const gl = GL(width, height);
    const resizeMode = "stretch";
    if (!gl) {
      throw new Error(
        "gl returned null, this probably means that some dependencies are not installed. See README.",
      );
    }
    function convertFrame(buf) {
      return ndarray(buf, [width, height, channels], [channels, width * channels, 1]);
    }
    return ({ fromFrame, toFrame, progress }) => {
      if (!this.source) {
        return this.easingFunction(progress) > 0.5 ? toFrame : fromFrame;
      }
      const buffer = createBuffer(gl, [-1, -1, -1, 4, 4, -1], gl.ARRAY_BUFFER, gl.STATIC_DRAW);
      let transition;
      try {
        transition = createTransition(gl, this.source, { resizeMode });
        gl.clear(gl.COLOR_BUFFER_BIT);
        const fromFrameNdArray = convertFrame(fromFrame);
        const textureFrom = createTexture(gl, fromFrameNdArray);
        textureFrom.minFilter = gl.LINEAR;
        textureFrom.magFilter = gl.LINEAR;
        const toFrameNdArray = convertFrame(toFrame);
        const textureTo = createTexture(gl, toFrameNdArray);
        textureTo.minFilter = gl.LINEAR;
        textureTo.magFilter = gl.LINEAR;
        buffer.bind();
        transition.draw(
          this.easingFunction(progress),
          textureFrom,
          textureTo,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          this.params,
        );
        textureFrom.dispose();
        textureTo.dispose();
        const outArray = Buffer.allocUnsafe(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, outArray);
        return outArray;
      } finally {
        buffer.dispose();
        if (transition) transition.dispose();
      }
    };
  }
}

const loadedFonts = [];
async function validateArbitraryAudio(audio, allowRemoteRequests) {
  assert(audio === void 0 || Array.isArray(audio));
  if (audio) {
    for (const { path, cutFrom, cutTo, start } of audio) {
      await assertFileValid(path, allowRemoteRequests);
      if (cutFrom != null && cutTo != null) assert(cutTo > cutFrom);
      if (cutFrom != null) assert(cutFrom >= 0);
      if (cutTo != null) assert(cutTo >= 0);
      assert(start == null || start >= 0, `Invalid "start" ${start}`);
    }
  }
}
async function parseConfig({
  clips,
  arbitraryAudio: arbitraryAudioIn,
  backgroundAudioPath,
  backgroundAudioVolume,
  loopAudio,
  allowRemoteRequests,
  defaults,
}) {
  async function handleLayer(layer) {
    if (layer.type === "image" || layer.type === "image-overlay") {
      await assertFileValid(layer.path, allowRemoteRequests);
    } else if (layer.type === "gl") {
      await assertFileValid(layer.fragmentPath, allowRemoteRequests);
    }
    if (["fabric", "canvas"].includes(layer.type)) {
      assert(typeof layer.func === "function", '"func" must be a function');
    }
    if (
      [
        "image",
        "image-overlay",
        "fabric",
        "canvas",
        "gl",
        "radial-gradient",
        "linear-gradient",
        "fill-color",
      ].includes(layer.type)
    ) {
      return layer;
    }
    if (["title", "subtitle", "news-title", "slide-in-text"].includes(layer.type)) {
      const { fontPath, ...rest } = layer;
      assert(rest.text, "Please specify a text");
      let { fontFamily } = rest;
      if (fontPath) {
        fontFamily = Buffer.from(basename(fontPath)).toString("base64");
        if (!loadedFonts.includes(fontFamily)) {
          registerFont(fontPath, { family: fontFamily, weight: "regular", style: "normal" });
          loadedFonts.push(fontFamily);
        }
      }
      return { ...rest, fontFamily };
    }
    throw new Error(`Invalid layer type ${layer.type}`);
  }
  const detachedAudioByClip = {};
  let clipsOut = await pMap(
    clips,
    async (clip, clipIndex) => {
      const { layers } = clip;
      const transition = new Transition(clip.transition, clipIndex === clips.length - 1);
      let layersOut = flatMap$1(
        await pMap(
          layers,
          async (layer) => {
            if (layer.type === "video") {
              const {
                duration: fileDuration,
                width: widthIn,
                height: heightIn,
                framerateStr,
                rotation,
              } = await readVideoFileInfo(layer.path);
              let { cutFrom, cutTo } = layer;
              if (!cutFrom) cutFrom = 0;
              cutFrom = Math.max(cutFrom, 0);
              cutFrom = Math.min(cutFrom, fileDuration);
              if (!cutTo) cutTo = fileDuration;
              cutTo = Math.max(cutTo, cutFrom);
              cutTo = Math.min(cutTo, fileDuration);
              assert(cutFrom < cutTo, "cutFrom must be lower than cutTo");
              const layerDuration = cutTo - cutFrom;
              const isRotated = rotation && [-90, 90, 270, -270].includes(rotation);
              const inputWidth = isRotated ? heightIn : widthIn;
              const inputHeight = isRotated ? widthIn : heightIn;
              return {
                ...layer,
                cutFrom,
                cutTo,
                layerDuration,
                framerateStr,
                inputWidth,
                inputHeight,
              };
            }
            if (["audio", "detached-audio"].includes(layer.type)) return layer;
            return handleLayer(layer);
          },
          { concurrency: 1 },
        ),
      );
      let clipDuration = clip.duration;
      if (!clipDuration) {
        const video = layersOut.find((layer) => layer.type === "video");
        clipDuration = video?.layerDuration ?? defaults.duration;
      }
      assert(clipDuration, `Duration parameter is required for videoless clip ${clipIndex}`);
      layersOut = (
        await pMap(layersOut, async (layerIn) => {
          if (!layerIn.start) layerIn.start = 0;
          const layerDuration = (layerIn.stop || clipDuration) - layerIn.start;
          assert(
            layerDuration > 0 && layerDuration <= clipDuration,
            `Invalid start ${layerIn.start} or stop ${layerIn.stop} (${clipDuration})`,
          );
          const layer = { ...layerIn, layerDuration };
          if (layer.type === "audio") {
            const fileDuration = await readDuration(layer.path);
            let { cutFrom, cutTo } = layer;
            if (!cutFrom) cutFrom = 0;
            cutFrom = Math.max(cutFrom, 0);
            cutFrom = Math.min(cutFrom, fileDuration);
            if (!cutTo) cutTo = cutFrom + clipDuration;
            cutTo = Math.max(cutTo, cutFrom);
            cutTo = Math.min(cutTo, fileDuration);
            assert(cutFrom < cutTo, "cutFrom must be lower than cutTo");
            const layerDuration2 = cutTo - cutFrom;
            const speedFactor = clipDuration / layerDuration2;
            return { ...layer, cutFrom, cutTo, speedFactor };
          }
          if (layer.type === "video") {
            let speedFactor;
            if (clipDuration) {
              speedFactor = clipDuration / layerDuration;
            } else {
              speedFactor = 1;
            }
            return { ...layer, speedFactor };
          }
          if (layer.type === "detached-audio") {
            if (!detachedAudioByClip[clipIndex]) detachedAudioByClip[clipIndex] = [];
            detachedAudioByClip[clipIndex].push(layer);
            return void 0;
          }
          return layer;
        })
      ).filter((l) => l !== void 0);
      layersOut = layersOut.filter((l) => l);
      return {
        transition,
        duration: clipDuration,
        layers: layersOut,
      };
    },
    { concurrency: 1 },
  );
  let totalClipDuration = 0;
  const clipDetachedAudio = [];
  clipsOut = await pMap(clipsOut, async (clip, i) => {
    const nextClip = clipsOut[i + 1];
    let safeTransitionDuration = 0;
    if (nextClip) {
      safeTransitionDuration = Math.min(
        clip.duration / 2,
        nextClip.duration / 2,
        clip.transition.duration,
      );
    }
    for (const { start, ...rest } of detachedAudioByClip[i] || []) {
      clipDetachedAudio.push({ ...rest, start: totalClipDuration + (start || 0) });
    }
    totalClipDuration += clip.duration - safeTransitionDuration;
    clip.transition.duration = safeTransitionDuration;
    return clip;
  });
  const arbitraryAudio = [
    // Background audio is treated just like arbitrary audio
    ...(backgroundAudioPath
      ? [
          {
            path: backgroundAudioPath,
            mixVolume: backgroundAudioVolume != null ? backgroundAudioVolume : 1,
            loop: loopAudio ? -1 : 0,
          },
        ]
      : []),
    ...arbitraryAudioIn,
    ...clipDetachedAudio,
  ];
  await validateArbitraryAudio(arbitraryAudio, allowRemoteRequests);
  return {
    clips: clipsOut,
    arbitraryAudio,
  };
}

const channels = 4;
async function Editly(input) {
  const config = new Configuration(input);
  const {
    // Testing options:
    verbose = false,
    logTimes = false,
    keepTmp = false,
    fast = false,
    outPath,
    clips: clipsIn,
    clipsAudioVolume,
    audioTracks: arbitraryAudioIn,
    width: requestedWidth,
    height: requestedHeight,
    fps: requestedFps,
    audioFilePath: backgroundAudioPath,
    backgroundAudioVolume,
    loopAudio,
    keepSourceAudio,
    allowRemoteRequests,
    audioNorm,
    outputVolume,
    customOutputArgs,
    isGif,
    tmpDir,
    defaults,
  } = config;
  await configureFf(config);
  if (backgroundAudioPath) await assertFileValid(backgroundAudioPath, allowRemoteRequests);
  if (verbose) console.log(JSON5.stringify(config, null, 2));
  const { clips, arbitraryAudio } = await parseConfig({
    clips: clipsIn,
    arbitraryAudio: arbitraryAudioIn,
    backgroundAudioPath,
    backgroundAudioVolume,
    loopAudio,
    allowRemoteRequests,
    defaults,
  });
  if (verbose) console.log("Calculated", JSON5.stringify({ clips, arbitraryAudio }, null, 2));
  if (verbose) console.log({ tmpDir });
  await fsExtra.mkdirp(tmpDir);
  const { editAudio } = Audio({ verbose, tmpDir });
  const audioFilePath = !isGif
    ? await editAudio({
        keepSourceAudio,
        arbitraryAudio,
        clipsAudioVolume,
        clips,
        audioNorm,
        outputVolume,
      })
    : void 0;
  let firstVideoWidth;
  let firstVideoHeight;
  let firstVideoFramerateStr;
  clips.find(
    (clip) =>
      clip &&
      clip.layers.find((layer) => {
        if (layer.type === "video") {
          firstVideoWidth = layer.inputWidth;
          firstVideoHeight = layer.inputHeight;
          firstVideoFramerateStr = layer.framerateStr;
          return true;
        }
        return false;
      }),
  );
  let width;
  let height;
  let desiredWidth;
  if (requestedWidth) desiredWidth = requestedWidth;
  else if (isGif) desiredWidth = 320;
  const roundDimension = (val) => (isGif ? Math.round(val) : multipleOf2(val));
  if (firstVideoWidth && firstVideoHeight) {
    if (desiredWidth) {
      const calculatedHeight = (firstVideoHeight / firstVideoWidth) * desiredWidth;
      height = roundDimension(calculatedHeight);
      width = desiredWidth;
    } else {
      width = firstVideoWidth;
      height = firstVideoHeight;
    }
  } else if (desiredWidth) {
    width = desiredWidth;
    height = desiredWidth;
  } else {
    width = 640;
    height = 640;
  }
  if (requestedWidth && requestedHeight) {
    width = requestedWidth;
    height = requestedHeight;
  }
  if (fast) {
    const numPixelsEachDirection = 250;
    const aspectRatio = width / height;
    width = roundDimension(numPixelsEachDirection * Math.sqrt(aspectRatio));
    height = roundDimension(numPixelsEachDirection * Math.sqrt(1 / aspectRatio));
  }
  assert(width, "Width not specified or detected");
  assert(height, "Height not specified or detected");
  if (!isGif) {
    width = Math.max(2, width);
    height = Math.max(2, height);
  }
  let fps;
  let framerateStr;
  if (fast) {
    fps = 15;
    framerateStr = String(fps);
  } else if (requestedFps && typeof requestedFps === "number") {
    fps = requestedFps;
    framerateStr = String(requestedFps);
  } else if (isGif) {
    fps = 10;
    framerateStr = String(fps);
  } else if (firstVideoFramerateStr) {
    fps = parseFps(firstVideoFramerateStr) ?? 25;
    framerateStr = firstVideoFramerateStr;
  } else {
    fps = 25;
    framerateStr = String(fps);
  }
  assert(fps, "FPS not specified or detected");
  console.log(`${width}x${height} ${fps}fps`);
  const estimatedTotalFrames =
    fps *
    clips.reduce((acc, c, i) => {
      let newAcc = acc + c.duration;
      if (i !== clips.length - 1) newAcc -= c.transition.duration;
      return newAcc;
    }, 0);
  function getOutputArgs() {
    if (customOutputArgs) {
      assert(Array.isArray(customOutputArgs), "customOutputArgs must be an array of arguments");
      return customOutputArgs;
    }
    const videoOutputArgs = isGif
      ? [
          "-vf",
          `format=rgb24,fps=${fps},scale=${width}:${height}:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
          "-loop",
          "0",
        ]
      : [
          "-vf",
          "format=yuv420p",
          "-vcodec",
          "libx264",
          "-profile:v",
          "high",
          ...(fast ? ["-preset:v", "ultrafast"] : ["-preset:v", "medium"]),
          "-crf",
          "18",
          "-movflags",
          "faststart",
        ];
    const audioOutputArgs = audioFilePath ? ["-acodec", "aac", "-b:a", "128k"] : [];
    return [...audioOutputArgs, ...videoOutputArgs];
  }
  function startFfmpegWriterProcess() {
    const args = [
      "-f",
      "rawvideo",
      "-vcodec",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-r",
      framerateStr,
      "-i",
      "-",
      ...(audioFilePath ? ["-i", audioFilePath] : []),
      ...(!isGif ? ["-map", "0:v:0"] : []),
      ...(audioFilePath ? ["-map", "1:a:0"] : []),
      ...getOutputArgs(),
      "-y",
      outPath,
    ];
    return ffmpeg(args, {
      encoding: "buffer",
      buffer: false,
      stdin: "pipe",
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }
  let outProcess;
  let outProcessExitCode;
  let frameSource1;
  let frameSource2;
  let frameSource1Data;
  let totalFramesWritten = 0;
  let fromClipFrameAt = 0;
  let toClipFrameAt = 0;
  let transitionFromClipId = 0;
  const getTransitionToClipId = () => transitionFromClipId + 1;
  const getTransitionFromClip = () => clips[transitionFromClipId];
  const getTransitionToClip = () => clips[getTransitionToClipId()];
  const getSource = async (clip, clipIndex) =>
    createFrameSource({
      clip,
      clipIndex,
      width,
      height,
      channels,
      verbose,
      logTimes,
      framerateStr,
    });
  const getTransitionFromSource = async () =>
    getSource(getTransitionFromClip(), transitionFromClipId);
  const getTransitionToSource = async () =>
    getTransitionToClip() && getSource(getTransitionToClip(), getTransitionToClipId());
  try {
    try {
      outProcess = startFfmpegWriterProcess();
      let outProcessError;
      outProcess.on("exit", (code) => {
        if (verbose) console.log("Output ffmpeg exited", code);
        outProcessExitCode = code;
      });
      outProcess.catch((err) => {
        outProcessError = err;
      });
      frameSource1 = await getTransitionFromSource();
      frameSource2 = await getTransitionToSource();
      while (!outProcessError) {
        const transitionToClip = getTransitionToClip();
        const transitionFromClip = getTransitionFromClip();
        const fromClipNumFrames = Math.round(transitionFromClip.duration * fps);
        const toClipNumFrames = transitionToClip && Math.round(transitionToClip.duration * fps);
        const fromClipProgress = fromClipFrameAt / fromClipNumFrames;
        const toClipProgress = transitionToClip && toClipFrameAt / toClipNumFrames;
        const fromClipTime = transitionFromClip.duration * fromClipProgress;
        const toClipTime = transitionToClip && transitionToClip.duration * toClipProgress;
        const currentTransition = transitionFromClip.transition;
        const transitionNumFrames = Math.round(currentTransition.duration * fps);
        const runTransitionOnFrame = currentTransition.create({ width, height, channels });
        const transitionNumFramesSafe = Math.floor(
          Math.min(
            Math.min(
              fromClipNumFrames,
              toClipNumFrames != null ? toClipNumFrames : Number.MAX_SAFE_INTEGER,
            ) / 2,
            transitionNumFrames,
          ),
        );
        const transitionFrameAt = fromClipFrameAt - (fromClipNumFrames - transitionNumFramesSafe);
        if (!verbose) {
          const percentDone = Math.floor(100 * (totalFramesWritten / estimatedTotalFrames));
          if (totalFramesWritten % 10 === 0)
            process.stdout.write(`${String(percentDone).padStart(3, " ")}% `);
        }
        const transitionLastFrameIndex = transitionNumFramesSafe;
        if (transitionFrameAt >= transitionLastFrameIndex) {
          transitionFromClipId += 1;
          console.log(
            `Done with transition, switching to next transitionFromClip (${transitionFromClipId})`,
          );
          if (!getTransitionFromClip()) {
            console.log("No more transitionFromClip, done");
            break;
          }
          await frameSource1.close();
          frameSource1 = frameSource2;
          frameSource2 = await getTransitionToSource();
          fromClipFrameAt = transitionLastFrameIndex;
          toClipFrameAt = 0;
          continue;
        }
        if (logTimes) console.time("Read frameSource1");
        const newFrameSource1Data = await frameSource1.readNextFrame({ time: fromClipTime });
        if (logTimes) console.timeEnd("Read frameSource1");
        if (newFrameSource1Data) frameSource1Data = newFrameSource1Data;
        else console.warn("No frame data returned, using last frame");
        const isInTransition =
          frameSource2 && transitionNumFramesSafe > 0 && transitionFrameAt >= 0;
        let outFrameData;
        if (isInTransition) {
          if (logTimes) console.time("Read frameSource2");
          const frameSource2Data = await frameSource2.readNextFrame({ time: toClipTime });
          if (logTimes) console.timeEnd("Read frameSource2");
          if (frameSource2Data) {
            const progress = transitionFrameAt / transitionNumFramesSafe;
            if (logTimes) console.time("runTransitionOnFrame");
            outFrameData = runTransitionOnFrame({
              fromFrame: frameSource1Data,
              toFrame: frameSource2Data,
              progress,
            });
            if (logTimes) console.timeEnd("runTransitionOnFrame");
          } else {
            console.warn("Got no frame data from transitionToClip!");
            outFrameData = frameSource1Data;
          }
        } else {
          outFrameData = frameSource1Data;
        }
        if (verbose) {
          if (isInTransition)
            console.log(
              "Writing frame:",
              totalFramesWritten,
              "from clip",
              transitionFromClipId,
              `(frame ${fromClipFrameAt})`,
              "to clip",
              getTransitionToClipId(),
              `(frame ${toClipFrameAt} / ${transitionNumFramesSafe})`,
              currentTransition.name,
              `${currentTransition.duration}s`,
            );
          else
            console.log(
              "Writing frame:",
              totalFramesWritten,
              "from clip",
              transitionFromClipId,
              `(frame ${fromClipFrameAt})`,
            );
        }
        const nullOutput = false;
        if (logTimes) console.time("outProcess.write");
        if (!nullOutput) await new Promise((r) => outProcess?.stdin?.write(outFrameData, r));
        if (logTimes) console.timeEnd("outProcess.write");
        if (outProcessError) break;
        totalFramesWritten += 1;
        fromClipFrameAt += 1;
        if (isInTransition) toClipFrameAt += 1;
      }
      outProcess.stdin?.end();
    } catch (err) {
      outProcess?.kill();
      throw err;
    } finally {
      if (verbose) console.log("Cleanup");
      if (frameSource1) await frameSource1.close();
      if (frameSource2) await frameSource2.close();
    }
    try {
      if (verbose) console.log("Waiting for output ffmpeg process to finish");
      await outProcess;
    } catch (err) {
      if (outProcessExitCode !== 0 && !err.isTerminated) throw err;
    }
  } finally {
    if (!keepTmp) await fsExtra.remove(tmpDir);
  }
  console.log();
  console.log("Done. Output file can be found at:");
  console.log(outPath);
}
async function renderSingleFrame(input) {
  const time = input.time ?? 0;
  const config = new Configuration(input);
  const {
    clips: clipsIn,
    allowRemoteRequests,
    width = 800,
    height = 600,
    verbose,
    logTimes,
    outPath = `${Math.floor(Math.random() * 1e12)}.png`,
    defaults,
  } = config;
  configureFf(config);
  console.log({ clipsIn });
  const { clips } = await parseConfig({
    clips: clipsIn,
    arbitraryAudio: [],
    allowRemoteRequests,
    defaults,
  });
  let clipStartTime = 0;
  const clip = clips.find((c) => {
    if (clipStartTime <= time && clipStartTime + c.duration > time) return true;
    clipStartTime += c.duration;
    return false;
  });
  assert(clip, "No clip found at requested time");
  const clipIndex = clips.indexOf(clip);
  const frameSource = await createFrameSource({
    clip,
    clipIndex,
    width,
    height,
    channels,
    verbose,
    logTimes,
    framerateStr: "1",
  });
  const rgba = await frameSource.readNextFrame({ time: time - clipStartTime });
  const canvas = createFabricCanvas({ width, height });
  const fabricImage = await rgbaToFabricImage({ width, height, rgba });
  canvas.add(fabricImage);
  canvas.renderAll();
  const internalCanvas = canvas.getNodeCanvas();
  await fsExtra.writeFile(outPath, internalCanvas.toBuffer("image/png"));
  canvas.clear();
  canvas.dispose();
  await frameSource.close();
}
Editly.renderSingleFrame = renderSingleFrame;

export { Editly as default, renderSingleFrame };
//# sourceMappingURL=index.js.map
