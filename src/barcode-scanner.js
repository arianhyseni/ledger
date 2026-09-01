const SCANNER_CAMERA_KEY = 'tillroll-scanner-camera';
const SCAN_INTERVAL_MS = 160;
const MAX_DECODE_EDGE = 960;

function readSavedCamera() {
  try { return localStorage.getItem(SCANNER_CAMERA_KEY); } catch (_) { return null; }
}

function saveCamera(deviceId) {
  if (!deviceId) return;
  try { localStorage.setItem(SCANNER_CAMERA_KEY, deviceId); } catch (_) {}
}

function clearSavedCamera() {
  try { localStorage.removeItem(SCANNER_CAMERA_KEY); } catch (_) {}
}

function disposeStream(stream, video) {
  if (stream && stream.getTracks) stream.getTracks().forEach(track => track.stop());
  if (video && (!stream || video.srcObject === stream)) {
    video.pause();
    video.srcObject = null;
  }
}

/* Android exposes each physical lens as a separate video input. Asking only
   for an "environment" camera can select an ultra-wide, telephoto, or
   fixed-focus lens, so rank the labelled rear cameras with the primary lens
   first. Samsung normally exposes that lens as camera2 0. */
export function scannerCameraScore(device) {
  const label = (device.label || '').toLowerCase();
  let score = 0;
  if (/rear|back|environment|facing back/.test(label)) score += 100;
  if (/front|user|facing front/.test(label)) score -= 1000;
  if (/main|primary/.test(label)) score += 80;
  if (/camera2[\s:_-]*0\b|camera[\s:_-]*0\b/.test(label)) score += 55;
  if (/\bwide\b/.test(label) && !/ultra/.test(label)) score += 10;
  if (/ultra[\s-]*wide|0[.,]5\s*x/.test(label)) score -= 160;
  if (/tele|zoom|periscope/.test(label)) score -= 90;
  if (/macro|depth/.test(label)) score -= 140;
  return score;
}

export function rankScannerCameras(devices) {
  const videoDevices = devices.filter(device => device.kind === 'videoinput');
  const labelledRear = videoDevices.filter(device => {
    const label = (device.label || '').toLowerCase();
    return /rear|back|environment|facing back/.test(label) &&
      !/front|user|facing front/.test(label);
  });
  const nonFront = videoDevices.filter(device =>
    !/front|user|facing front/.test((device.label || '').toLowerCase()));
  const candidates = labelledRear.length ? labelledRear : (nonFront.length ? nonFront : videoDevices);

  return candidates.slice().sort((a, b) =>
    scannerCameraScore(b) - scannerCameraScore(a) ||
    (a.label || '').localeCompare(b.label || ''));
}

export function scannerFormats(BarcodeFormat, mode = 'retail') {
  if (mode === 'qr') {
    return [BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX];
  }
  if (mode === 'payment') {
    return [
      BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
      BarcodeFormat.ITF, BarcodeFormat.CODABAR,
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E
    ];
  }
  return [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
    BarcodeFormat.ITF, BarcodeFormat.RSS_14
  ];
}

function barcodeVideoConstraints(deviceId, relaxed = false) {
  const video = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: 'environment' } };

  video.width = { ideal: relaxed ? 1280 : 1920 };
  video.height = { ideal: relaxed ? 720 : 1080 };
  if (!relaxed) video.frameRate = { ideal: 30, max: 30 };

  const supported = navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints() : {};
  if (supported.resizeMode) video.resizeMode = { ideal: 'none' };
  return { audio: false, video };
}

async function openCamera(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia(barcodeVideoConstraints(deviceId));
  } catch (err) {
    const constraintFailure = err && (
      err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError'
    );
    if (!constraintFailure) throw err;
    return navigator.mediaDevices.getUserMedia(barcodeVideoConstraints(deviceId, true));
  }
}

function waitForFrames(video, session) {
  if (video.videoWidth > 0 && video.readyState >= 2) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('canplay', done);
      if (session.cancelFrameWait === done) session.cancelFrameWait = null;
      resolve();
    };
    const timer = setTimeout(done, 2500);
    session.cancelFrameWait = done;
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('canplay', done);
  });
}

async function tuneCamera(video, session, log) {
  await waitForFrames(video, session);
  if (session.cancelled) return;

  const stream = video.srcObject;
  const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track) return;
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};

  // A focus distance is a manual-focus setting. Applying it separately also
  // replaces the previous constraints, which disabled continuous autofocus on
  // affected phones. Apply one coherent autofocus request and verify settings.
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (err) {
      log('Scanner continuous autofocus was not available:', err.message || err);
    }
  }

  const settings = track.getSettings ? track.getSettings() : {};
  session.diag.width = settings.width || video.videoWidth || 0;
  session.diag.height = settings.height || video.videoHeight || 0;
  session.diag.focusMode = settings.focusMode || '';
  session.diag.cameraLabel = track.label || session.diag.cameraLabel;
  log('Scanner stream:', {
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    facingMode: settings.facingMode,
    focusMode: settings.focusMode,
    camera: track.label
  });
}

/* Convert the visible guide box back into source-video coordinates. The
   portrait preview uses object-fit: cover, so much of a landscape camera frame
   is off-screen. Decoding only what the user can see is both faster and more
   predictable than processing a second full-HD rotated frame on every miss. */
export function barcodeScanRegion(video, frame) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const videoRect = video.getBoundingClientRect();
  if (!width || !height || !videoRect.width || !videoRect.height || !frame) {
    return { sx: width * 0.1, sy: height * 0.3, sw: width * 0.8, sh: height * 0.4 };
  }

  const frameRect = frame.getBoundingClientRect();
  const scale = Math.max(videoRect.width / width, videoRect.height / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const offsetX = (videoRect.width - renderedWidth) / 2;
  const offsetY = (videoRect.height - renderedHeight) / 2;
  const padX = frameRect.width * 0.08;
  const padY = frameRect.height * 0.08;
  const left = frameRect.left - padX - videoRect.left;
  const top = frameRect.top - padY - videoRect.top;
  const right = frameRect.right + padX - videoRect.left;
  const bottom = frameRect.bottom + padY - videoRect.top;

  const sx = Math.max(0, (left - offsetX) / scale);
  const sy = Math.max(0, (top - offsetY) / scale);
  const ex = Math.min(width, (right - offsetX) / scale);
  const ey = Math.min(height, (bottom - offsetY) / scale);
  if (ex - sx < 80 || ey - sy < 80) {
    return { sx: width * 0.1, sy: height * 0.3, sw: width * 0.8, sh: height * 0.4 };
  }
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

function drawDecodeFrame(video, frame, canvas) {
  const region = barcodeScanRegion(video, frame);
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(region.sw, region.sh));
  const width = Math.max(1, Math.round(region.sw * scale));
  const height = Math.max(1, Math.round(region.sh * scale));
  // ZXing's 1D TRY_HARDER path rotates the luminance source internally. A
  // square surface keeps its source dimensions valid after that 90° rotation.
  const size = Math.max(width, height);
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  let context;
  try { context = canvas.getContext('2d', { willReadFrequently: true }); }
  catch (_) { context = canvas.getContext('2d'); }
  if (!context) throw new Error('The scanner could not prepare a camera frame.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.drawImage(
    video, region.sx, region.sy, region.sw, region.sh,
    Math.round((size - width) / 2), Math.round((size - height) / 2), width, height
  );
  return context;
}

function probeFrame(context, canvas, diag) {
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const stride = Math.max(4, Math.floor(pixels.length / 16000 / 4) * 4);
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels.length; i += stride) {
    const value = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  diag.min = min;
  diag.max = max;
  diag.spread = max - min;
}

export function createBarcodeScanner({ getElement, log = () => {} }) {
  let currentSession = null;
  let nextSessionId = 0;

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try { return rankScannerCameras(await navigator.mediaDevices.enumerateDevices()); }
    catch (_) { return []; }
  }

  function stopSession(session) {
    if (!session || session.cancelled) return;
    session.cancelled = true;
    clearTimeout(session.decodeTimer);
    if (session.cancelFrameWait) session.cancelFrameWait();
    disposeStream(session.stream, session.video);
    if (window.dumpScanFrame === session.dumpFrame) window.dumpScanFrame = null;
    if (currentSession === session) currentSession = null;
  }

  function stop() {
    if (currentSession) stopSession(currentSession);
  }

  function installFrameDump(session) {
    const dumpFrame = () => {
      const video = session.video;
      if (session.cancelled || currentSession !== session) return null;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(video, 0, 0);
      return canvas.toDataURL('image/png');
    };
    session.dumpFrame = dumpFrame;
    window.dumpScanFrame = dumpFrame;
  }

  function runDecodeLoop(session) {
    const canvas = document.createElement('canvas');
    const frame = getElement('scannerFrame') || document.querySelector('.scanner-frame');

    const schedule = () => {
      if (!session.cancelled && currentSession === session) {
        session.decodeTimer = setTimeout(decodeFrame, SCAN_INTERVAL_MS);
      }
    };

    const decodeFrame = () => {
      if (session.cancelled || currentSession !== session) return;
      const video = session.video;
      if (!video.videoWidth || video.readyState < 2) { schedule(); return; }

      try {
        const context = drawDecodeFrame(video, frame, canvas);
        session.diag.attempts++;
        session.diag.width = video.videoWidth;
        session.diag.height = video.videoHeight;
        session.diag.decodeWidth = canvas.width;
        session.diag.decodeHeight = canvas.height;
        if (session.diag.attempts % 4 === 0) probeFrame(context, canvas, session.diag);

        const result = session.reader.decodeFromCanvas(canvas);
        if (result) {
          const text = result.getText();
          const callback = session.onResult;
          saveCamera(session.deviceId);
          // Detach the camera before notifying prices.js. This closes the race
          // where the first result arrived before ZXing returned its controls.
          stopSession(session);
          callback(text);
          return;
        }
      } catch (err) {
        // These errors are expected on ordinary frames while the user aims.
        session.diag.lastError = err && err.name ? err.name : 'DecodeError';
        if (err && !/NotFound|Checksum|Format/.test(err.name || '') && !session.loggedDecodeError) {
          session.loggedDecodeError = true;
          log('Scanner frame could not be decoded:', err.message || err);
        }
      }
      schedule();
    };

    decodeFrame();
  }

  async function prepareStream(session, requestedDeviceId) {
    let cameras = await listCameras();
    if (session.cancelled || currentSession !== session) return null;
    const savedDeviceId = readSavedCamera();
    const knownIds = new Set(cameras.map(camera => camera.deviceId));
    let chosenDeviceId = requestedDeviceId ||
      (savedDeviceId && knownIds.has(savedDeviceId) ? savedDeviceId : null);
    let failedDeviceId = null;
    if (savedDeviceId && cameras.length && !knownIds.has(savedDeviceId)) clearSavedCamera();

    let stream;
    try {
      stream = await openCamera(chosenDeviceId);
    } catch (err) {
      // A persisted device can disappear after a browser/OS update.
      if (!chosenDeviceId) throw err;
      const deviceFailure = /NotFound|DevicesNotFound|Overconstrained|ConstraintNotSatisfied|NotReadable|TrackStart|Abort/
        .test(err && err.name || '');
      if (!deviceFailure) throw err;
      if (session.cancelled || currentSession !== session) return null;
      failedDeviceId = chosenDeviceId;
      clearSavedCamera();
      chosenDeviceId = null;
      stream = await openCamera(null);
    }
    if (session.cancelled || currentSession !== session) {
      disposeStream(stream);
      return null;
    }

    cameras = await listCameras();
    if (session.cancelled || currentSession !== session) {
      disposeStream(stream);
      return null;
    }
    const firstTrack = stream.getVideoTracks()[0];
    const firstSettings = firstTrack && firstTrack.getSettings ? firstTrack.getSettings() : {};
    const activeId = firstSettings.deviceId || null;
    const rankedIds = new Set(cameras.map(camera => camera.deviceId));
    const bestDeviceId = failedDeviceId ? activeId : (requestedDeviceId ||
      (savedDeviceId && rankedIds.has(savedDeviceId) ? savedDeviceId :
        (cameras[0] && cameras[0].deviceId)));

    // Permission reveals device labels. If Android initially opened an
    // auxiliary lens, close it and reopen the ranked primary rear camera.
    if (bestDeviceId && activeId && bestDeviceId !== activeId) {
      disposeStream(stream);
      stream = await openCamera(bestDeviceId);
      if (session.cancelled || currentSession !== session) {
        disposeStream(stream);
        return null;
      }
    }

    const track = stream.getVideoTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    const usableCameras = failedDeviceId && failedDeviceId !== settings.deviceId
      ? cameras.filter(camera => camera.deviceId !== failedDeviceId) : cameras;
    session.stream = stream;
    session.cameras = usableCameras;
    session.deviceId = settings.deviceId || bestDeviceId || activeId || null;
    session.diag.cameraCount = usableCameras.length;
    session.diag.cameraIndex = Math.max(0,
      usableCameras.findIndex(camera => camera.deviceId === session.deviceId)) + 1;
    session.diag.cameraLabel = (usableCameras.find(camera => camera.deviceId === session.deviceId) || {}).label ||
      (track && track.label) || '';
    saveCamera(session.deviceId);
    return stream;
  }

  async function start(videoElementId, onResult, onError, options = {}) {
    stop();
    const settings = options && typeof options === 'object' ? options : {};
    const requestedDeviceId = typeof options === 'string' ? options : settings.deviceId || null;
    const mode = ['qr', 'payment'].includes(settings.mode) ? settings.mode : 'retail';
    const video = getElement(videoElementId);
    const session = {
      id: ++nextSessionId,
      video,
      stream: null,
      reader: null,
      decodeTimer: null,
      cancelFrameWait: null,
      cancelled: false,
      cameras: [],
      deviceId: null,
      mode,
      onResult,
      onError,
      diag: {
        attempts: 0, lastError: null, width: 0, height: 0,
        decodeWidth: 0, decodeHeight: 0, started: Date.now(),
        min: 0, max: 0, spread: 0, focusMode: '',
        cameraCount: 0, cameraIndex: 0, cameraLabel: ''
      }
    };
    currentSession = session;
    window.scanDiag = session.diag;

    try {
      if (!video) throw new Error('Scanner preview is unavailable.');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera scanning is not supported in this browser.');
      }

      const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library')
      ]);
      if (session.cancelled || currentSession !== session) return false;

      const hints = new Map([
        [DecodeHintType.POSSIBLE_FORMATS, scannerFormats(BarcodeFormat, mode)],
        // TRY_HARDER scans more rows and handles 90-degree rotation inside the
        // bounded guide crop, replacing the old second full-HD decode pass.
        [DecodeHintType.TRY_HARDER, true]
      ]);
      session.reader = new BrowserMultiFormatReader(hints);

      const stream = await prepareStream(session, requestedDeviceId);
      if (!stream || session.cancelled || currentSession !== session) return false;
      video.srcObject = stream;
      try { await video.play(); } catch (_) { /* muted + playsinline normally autoplays */ }
      await waitForFrames(video, session);
      if (session.cancelled || currentSession !== session) return false;
      if (!video.videoWidth) throw new Error('The camera opened but did not provide a video frame.');

      await tuneCamera(video, session, log);
      if (session.cancelled || currentSession !== session) return false;
      installFrameDump(session);
      runDecodeLoop(session);
      return true;
    } catch (err) {
      const shouldReport = currentSession === session && !session.cancelled;
      stopSession(session);
      if (shouldReport && typeof onError === 'function') onError(err);
      return false;
    }
  }

  async function switchCamera() {
    const current = currentSession;
    if (!current || current.cancelled) return false;
    const cameras = current.cameras.length ? current.cameras : await listCameras();
    if (current.cancelled || currentSession !== current) return false;
    if (cameras.length < 2) return false;
    const currentIndex = cameras.findIndex(camera => camera.deviceId === current.deviceId);
    const nextCamera = cameras[(currentIndex + 1 + cameras.length) % cameras.length];
    if (!nextCamera) return false;
    return start(current.video.id, current.onResult, current.onError, {
      deviceId: nextCamera.deviceId,
      mode: current.mode
    });
  }

  return { start, stop, switchCamera };
}
