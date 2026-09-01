import test from 'node:test';
import assert from 'node:assert/strict';

import {
  barcodeScanRegion,
  rankScannerCameras,
  scannerCameraScore,
  scannerFormats
} from '../src/barcode-scanner.js';

test('scanner modes keep retail barcodes separate from bill payment QR formats', () => {
  const formats = {
    EAN_13: 'ean13', EAN_8: 'ean8', UPC_A: 'upca', UPC_E: 'upce',
    CODE_128: 'code128', CODE_39: 'code39', ITF: 'itf', RSS_14: 'rss14',
    CODE_93: 'code93', CODABAR: 'codabar',
    QR_CODE: 'qr', DATA_MATRIX: 'data-matrix'
  };
  assert.deepEqual(scannerFormats(formats, 'qr'), ['qr', 'data-matrix']);
  assert.ok(scannerFormats(formats, 'retail').includes('ean13'));
  assert.ok(!scannerFormats(formats, 'retail').includes('qr'));
  assert.ok(scannerFormats(formats, 'payment').includes('code128'));
  assert.ok(scannerFormats(formats, 'payment').includes('qr'));
});

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
