import fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const ASSETS_DIR = path.resolve(process.cwd(), 'aita', 'web', 'assets');

export interface MascotClipSpec {
  id: 'readerIdle' | 'tutorWelcome' | 'tutorThinking' | 'libraryIdle' | 'syllabusScan';
  sourceFile: string;
  mimeType: string;
  outputFile: string;
  prompt: string;
}

export const MASCOT_CLIPS: MascotClipSpec[] = [
  {
    id: 'readerIdle',
    sourceFile: 'biibo-reader-empty.jpg',
    mimeType: 'image/jpeg',
    outputFile: 'biibo-reader-idle.mp4',
    prompt:
      'Use the first image as the exact First Frame (starting frame) and the second identical image as the exact Last Frame (ending frame) so the animation returns seamlessly to the exact initial pose on the final frame with zero loop jump. ' +
      'Static camera, locked tripod shot, zero camera movement, no zoom. Turn this static image into a subtle, seamless loop animation for a website mascot. ' +
      'The cute pastel mint-green and lavender 3D creature sits calmly beside the open white book on a clean solid off-white background. ' +
      'It gently breathes with a soft vertical float, blinks its eyes naturally once, and flutters its tiny side wings and antennae very delicately. ' +
      'Keep the open book, lighting, shadows, and background completely still and unchanged. Smooth, gentle, cute 3D motion.',
  },
  {
    id: 'tutorWelcome',
    sourceFile: 'biibo-tutor-welcome.jpg',
    mimeType: 'image/jpeg',
    outputFile: 'biibo-tutor-welcome.mp4',
    prompt:
      'Strict 2-frame keyframe interpolation: use the first image as the exact pixel-locked First Frame (at 0.0s) and the second identical image as the exact pixel-locked Last Frame (at 4.0s) so the video returns smoothly to the exact starting frame with zero jump when looping infinitely. ' +
      'Static camera, locked tripod shot, no pan, no zoom, no framing shift. ' +
      'Bring this cute pastel mint-green and lavender 3D mascot to life with ultra-subtle, calm looping motion: ' +
      'keep BOTH arms and hands completely steady in their exact initial pose—do NOT wave, swing, lower, or reposition the raised left arm or the right hand holding the yellow cloud. ' +
      'Only animate a gentle breathing rise-and-fall in place, one warm natural eye blink, and delicate subtle wiggles of the glowing yellow antennae tips and tiny side wings, returning smoothly to the exact initial pose before the final frame. ' +
      'Keep the soft pastel lavender background, lighting, and floor shadow 100% still and unchanged.',
  },
  {
    id: 'tutorThinking',
    sourceFile: 'biibo-tutor-thinking.jpg',
    mimeType: 'image/jpeg',
    outputFile: 'biibo-tutor-thinking.mp4',
    prompt:
      'Strict 2-frame keyframe interpolation: use the first image as the exact pixel-locked First Frame (at 0.0s) and the second identical image as the exact pixel-locked Last Frame (at 4.0s) so the video returns seamlessly to the exact starting pose on the final frame with zero loop jump. ' +
      'Static camera, locked tripod shot, zero camera movement, no pan, no zoom. ' +
      'Animate this cute pastel mint-green and lavender fuzzy 3D mascot in an adorable thoughtful pondering motion: ' +
      'its body and head gently tilt about 8 to 10 degrees to the right in curious thought while keeping its raised short hand resting gently near its mouth and cheek in a chin-resting pondering pose and its other short hand resting naturally at its side. ' +
      'Its two tiny antennae on top of its head sway gently in an alternating back-and-forth rhythm like tiny signal-receiving antennas, while the glowing pastel mint-green and butter-yellow tips softly pulse with delicate warm light. ' +
      'Add one gentle natural eye blink and soft breathing, then smoothly tilt back to the exact initial pose before the final frame. ' +
      'Keep the soft pastel lavender background, lighting, and floor shadow 100% still and unchanged.',
  },
  {
    id: 'libraryIdle',
    sourceFile: 'biibo-library-empty.jpg',
    mimeType: 'image/jpeg',
    outputFile: 'biibo-library-idle.mp4',
    prompt:
      'Use the first image as the exact First Frame (starting frame) and the second identical image as the exact Last Frame (ending frame) so the animation returns seamlessly to the exact initial pose on the final frame with zero loop jump. ' +
      'Static camera, locked tripod shot, zero camera movement, no pan, no zoom. Turn this static image into a subtle, seamless loop animation for a website mascot. ' +
      'The cute pastel mint-green and lavender 3D creature stands calmly beside the two neat stacks of pastel hardcover books on the clean solid off-white background, holding its tiny butter-yellow cloud. ' +
      'It gently breathes in place with a soft subtle float, blinks its eyes warmly once, and delicately wiggles its glowing butter-yellow antennae and tiny side wings. ' +
      'Keep both stacks of books, lighting, floor shadows, and off-white background completely still and unchanged. Smooth, calm, cute 3D seamless loop.',
  },
  {
    id: 'syllabusScan',
    sourceFile: 'biibo-syllabus-scan.jpg',
    mimeType: 'image/jpeg',
    outputFile: 'biibo-syllabus-scan.mp4',
    prompt:
      'Strict 2-frame keyframe interpolation: use the first image as the exact pixel-locked First Frame (at 0.0s) and the second identical image as the exact pixel-locked Last Frame (at 4.0s) so the animation returns seamlessly to the exact starting frame with zero jump when looping infinitely. ' +
      'Static camera, locked tripod shot, zero camera movement, no pan, no zoom, no framing shift. ' +
      'Animate this cute pastel mint-green and lavender fuzzy 3D mascot eagerly scanning its mini open cream-white book: ' +
      'keep both short hands holding the open mini cream-white book steady in front of its chest while the tiny white pages flutter subtly as if speed-reading slides. ' +
      'Its dark glossy eyes dart rapidly left and right across the open pages in focused speed-reading motion with one quick blink. ' +
      'Tiny glowing pastel mint-green and butter-yellow knowledge light particles drift smoothly upward out of the open book pages and get drawn into the two glowing antennae tips on top of its head, making the antennae gently wiggle and pulse softly with warm light as they absorb knowledge. ' +
      'Return smoothly to the exact initial pose and sparkle positions before the final frame. Keep the clean pastel lavender background, soft lighting, and floor shadow 100% still and unchanged.',
  },
];

let activeRun: Promise<Record<string, string>> | null = null;
let lastError: string | null = null;

export function getMascotStatus() {
  const ready: Record<string, boolean> = {};
  for (const clip of MASCOT_CLIPS) {
    const filePath = path.join(ASSETS_DIR, clip.outputFile);
    ready[clip.id] = fs.existsSync(filePath) && fs.statSync(filePath).size > 1024;
  }
  return {
    ready,
    generating: Boolean(activeRun),
    error: lastError,
  };
}

async function generateOne(ai: GoogleGenAI, spec: MascotClipSpec, force: boolean): Promise<string> {
  const outPath = path.join(ASSETS_DIR, spec.outputFile);
  if (!force && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    return 'cached';
  }
  const srcPath = path.join(ASSETS_DIR, spec.sourceFile);
  const imageBase64 = (await readFile(srcPath)).toString('base64');

  const interaction = await ai.interactions.create(
    {
      model: 'gemini-omni-1.2-flash',
      input: [
        { type: 'image', mime_type: spec.mimeType, data: imageBase64 },
        { type: 'image', mime_type: spec.mimeType, data: imageBase64 },
        { type: 'text', text: spec.prompt },
      ],
      background: false,
      store: false,
      stream: false,
      response_format: {
        type: 'video',
        aspect_ratio: '16:9',
        duration: '4s',
        resolution: '720p',
      },
    } as never,
    { timeout: 300000 }
  );

  const raw = interaction as unknown as {
    output_video?: { data?: string; uri?: string };
    steps?: Array<{ content?: Array<{ type?: string; data?: string; uri?: string }> }>;
  };
  let videoOut = raw.output_video;
  if (!videoOut?.data && !videoOut?.uri && Array.isArray(raw.steps)) {
    for (const step of raw.steps) {
      const found = step.content?.find((c) => c.type === 'video' && (c.data || c.uri));
      if (found) {
        videoOut = found;
        break;
      }
    }
  }

  let buffer: Buffer | null = null;
  if (videoOut?.data) {
    buffer = Buffer.from(videoOut.data, 'base64');
  } else if (videoOut?.uri) {
    let parsedUri: URL;
    try {
      parsedUri = new URL(videoOut.uri);
    } catch {
      throw new Error(`Invalid video download URL for ${spec.outputFile}`);
    }
    const isTrustedGoogleHost =
      parsedUri.protocol === 'https:' &&
      (parsedUri.hostname === 'generativelanguage.googleapis.com' ||
        parsedUri.hostname.endsWith('.googleapis.com'));
    if (!isTrustedGoogleHost) {
      throw new Error(`Untrusted video download host for ${spec.outputFile}`);
    }
    const res = await fetch(parsedUri.toString(), {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || (res.status >= 300 && res.status < 400)) {
      throw new Error(`Video download failed (${res.status}) for ${spec.outputFile}`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
  }

  if (!buffer || buffer.byteLength < 1024) {
    throw new Error(`No video data returned for ${spec.outputFile}`);
  }
  await writeFile(outPath, buffer);
  return `generated:${buffer.byteLength}`;
}

export async function animateMascotAssets(force = false, clipIds?: string[]): Promise<Record<string, string>> {
  if (activeRun) return activeRun;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured on the server.');
    lastError = err.message;
    throw err;
  }

  const ai = new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const targetClips = Array.isArray(clipIds) && clipIds.length
    ? MASCOT_CLIPS.filter((c) => clipIds.includes(c.id))
    : MASCOT_CLIPS;

  lastError = null;
  activeRun = (async () => {
    try {
      const results: Record<string, string> = {};
      for (const clip of targetClips) {
        results[clip.id] = await generateOne(ai, clip, force);
      }
      return results;
    } catch (error) {
      const e = error as { statusCode?: number; status?: number; body?: string; message?: string };
      const code = e?.statusCode || e?.status || 500;
      const body = typeof e?.body === 'string' ? e.body : e?.message || '';
      let upstreamMessage = '';
      try {
        const parsed = JSON.parse(body);
        const item = Array.isArray(parsed) ? parsed[0] : parsed;
        if (typeof item?.error?.message === 'string') upstreamMessage = item.error.message.trim();
      } catch {
        upstreamMessage = body.slice(0, 240);
      }
      if (code === 402) {
        lastError = `目前的 Gemini API 金鑰預付額度不足或已用盡（HTTP 402）：${upstreamMessage || '請確認專案計費與預付額度。'}`;
      } else if (code === 403) {
        lastError = `目前的 Gemini API 金鑰沒有影片生成模型的存取權限（HTTP 403）：${upstreamMessage || '請確認專案計費與金鑰設定。'}`;
      } else if (code === 429) {
        lastError = `影片生成請求已達額度或速率上限（HTTP 429）：${upstreamMessage || '請稍候片刻再重試。'}`;
      } else {
        lastError = `吉祥物影片生成失敗（HTTP ${code}）：${upstreamMessage || '請稍後再試。'}`;
      }
      const wrapped = new Error(lastError) as Error & { status?: number };
      wrapped.status = code >= 400 && code < 600 ? code : 502;
      throw wrapped;
    } finally {
      activeRun = null;
    }
  })();

  return activeRun;
}
