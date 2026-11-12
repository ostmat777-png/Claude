// Screen recording. The page captures and encodes; the main process picks the
// screen (there is no picker window) and writes the chunks to a file.

function pickMime(format, withAudio) {
  const mp4 = withAudio
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4']
    : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4'];
  const webm = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const order = format === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
  return order.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

/** A video track that shows only `crop` of the source track. */
function cropTrack(track, crop, onCleanup) {
  if ('MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window) {
    const processor = new MediaStreamTrackProcessor({ track });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    // Each frame is redrawn onto a canvas of exactly the wanted size. (Cropping by
    // the frame's "visible rectangle" looks simpler, but encoders round it and the
    // video comes out a couple of pixels smaller than asked.)
    const width = even(crop.width);
    const height = even(crop.height);
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { alpha: false });
    const transformer = new TransformStream({
      transform(frame, controller) {
        try {
          const x = Math.max(0, Math.min(crop.x, frame.displayWidth - width));
          const y = Math.max(0, Math.min(crop.y, frame.displayHeight - height));
          g.drawImage(frame, x, y, width, height, 0, 0, width, height);
          controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined }));
        } finally {
          frame.close();
        }
      },
    });
    processor.readable.pipeThrough(transformer).pipeTo(generator.writable).catch(() => {});
    onCleanup(() => {
      try { generator.stop(); } catch {}
    });
    return generator;
  }

  // Older engines: paint the wanted part of the video on a canvas and record that.
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = even(crop.width);
  canvas.height = even(crop.height);
  const g = canvas.getContext('2d', { alpha: false });
  let alive = true;
  const paint = () => {
    if (!alive) return;
    g.drawImage(video, crop.x, crop.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(paint);
    else setTimeout(paint, 33);
  };
  paint();
  onCleanup(() => {
    alive = false;
    video.srcObject = null;
  });
  return canvas.captureStream(30).getVideoTracks()[0];
}

export function setupRecorder(app) {
  const { api } = app;
  let recorder = null;
  let cleanups = [];
  let chain = Promise.resolve();
  let failed = null;

  function cleanup() {
    for (const fn of cleanups) {
      try { fn(); } catch {}
    }
    cleanups = [];
    recorder = null;
  }

  async function start(opts) {
    const wantSystem = opts.audio === 'system' || opts.audio === 'both';
    const wantMic = opts.audio === 'mic' || opts.audio === 'both';
    const video0 = { frameRate: { ideal: opts.fps, max: opts.fps } };
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: video0, audio: wantSystem });
    } catch (err) {
      if (!wantSystem) throw err;
      // no sound device to record from: the picture alone is better than nothing
      display = await navigator.mediaDevices.getDisplayMedia({ video: video0, audio: false });
    }
    cleanups.push(() => display.getTracks().forEach((t) => t.stop()));

    let video = display.getVideoTracks()[0];
    if (!video) throw new Error('Экран недоступен для записи');
    if (opts.crop) video = cropTrack(video, opts.crop, (fn) => cleanups.push(fn));

    const systemAudio = display.getAudioTracks()[0] || null;
    let mic = null;
    if (wantMic) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
        cleanups.push(() => micStream.getTracks().forEach((t) => t.stop()));
        mic = micStream.getAudioTracks()[0] || null;
      } catch {
        mic = null; // no microphone: record without it
      }
    }

    const tracks = [video];
    if (systemAudio && mic) {
      // Two sources into one track.
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([systemAudio])).connect(dest);
      ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
      cleanups.push(() => ctx.close().catch(() => {}));
      tracks.push(dest.stream.getAudioTracks()[0]);
    } else if (systemAudio || mic) {
      tracks.push(systemAudio || mic);
    }

    const mime = pickMime(opts.format, tracks.length > 1);
    if (!mime) throw new Error('Запись видео не поддерживается');
    const pixels = opts.crop ? opts.crop.width * opts.crop.height : 1920 * 1080;
    recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType: mime,
      videoBitsPerSecond: Math.round(Math.max(2_500_000, Math.min(16_000_000, pixels * 4))),
      audioBitsPerSecond: 160_000,
    });
    chain = Promise.resolve();
    failed = null;
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      // Keep the pieces in order, whatever order the reads finish in.
      chain = chain.then(async () => api.send('rec:chunk', await e.data.arrayBuffer())).catch(() => {});
    };
    recorder.onerror = (e) => {
      failed = String((e.error && e.error.message) || 'ошибка записи');
    };
    recorder.onstop = async () => {
      await chain;
      cleanup();
      api.invoke('rec:finish', failed);
    };
    // If the screen share ends by itself, finish the file properly.
    video.addEventListener('ended', () => stop());

    const ok = await api.invoke('rec:started', { mime });
    if (!ok) throw new Error('Запись отменена');
    recorder.start(1000);
  }

  function stop() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  api.on('rec:begin', async (opts) => {
    if (recorder) return;
    try {
      await start(opts);
    } catch (err) {
      cleanup();
      api.invoke('rec:finish', String((err && err.message) || err));
    }
  });
  api.on('rec:stop', stop);
}
