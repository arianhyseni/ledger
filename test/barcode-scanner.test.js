import test from 'node:test';
import assert from 'node:assert/strict';

import {
  barcodeScanRegion,
  rankScannerCameras,
  scannerCameraScore
} from '../src/barcode-scanner.js';

test('primary Samsung rear camera ranks above auxiliary lenses and front camera is excluded', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'front', label: 'camera2 1, facing front' },
    { kind: 'videoinput', deviceId: 'ultra', label: 'camera2 2, facing back ultra-wide' },
    { kind: 'videoinput', deviceId: 'tele', label: 'camera2 3, facing back telephoto' },
    { kind: 'videoinput', deviceId: 'main', label: 'camera2 0, facing back' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }
  ];

  const ranked = rankScannerCameras(devices);
  assert.equal(ranked[0].deviceId, 'main');
  assert.deepEqual(ranked.map(device => device.deviceId).sort(), ['main', 'tele', 'ultra']);
  assert.ok(scannerCameraScore(ranked[0]) > scannerCameraScore(devices[1]));
});

test('unlabelled video inputs remain switchable after permission metadata is unavailable', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'b', label: '' },
    { kind: 'videoinput', deviceId: 'a', label: '' }
  ];

  assert.deepEqual(rankScannerCameras(devices).map(device => device.deviceId).sort(), ['a', 'b']);
});

test('portrait cover preview maps the visible guide into the centre of a landscape source', () => {
  const video = {
    videoWidth: 1920,
    videoHeight: 1080,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 })
  };
  const frame = {
    getBoundingClientRect: () => ({ left: 40, top: 260, right: 360, bottom: 532, width: 320, height: 272 })
  };

  const region = barcodeScanRegion(video, frame);
  assert.ok(region.sx > 600 && region.sx < 800);
  assert.ok(region.sx + region.sw > 1100 && region.sx + region.sw < 1300);
  assert.ok(region.sy > 250 && region.sy < 400);
  assert.ok(region.sy + region.sh > 650 && region.sy + region.sh < 850);
  assert.ok(region.sw < video.videoWidth / 2);
});
