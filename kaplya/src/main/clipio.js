'use strict';
// Reading and writing the system clipboard.
//
// Electron changed this interface: newer versions have an asynchronous one modelled
// on the browser's (read() returns items with MIME types), older versions have
// readText() / readImage(). The rest of the app talks to this file and does not
// care which one it is.

const electron = require('electron');

const { clipboard } = electron;
const modern = typeof clipboard.read === 'function';

async function readText() {
  try {
    return String((await clipboard.readText()) || '');
  } catch {
    return '';
  }
}

async function writeText(text) {
  await clipboard.writeText(String(text));
}

/** MIME types of what is on the clipboard now, e.g. ['text/plain', 'text/html'] or ['image/png']. */
async function types() {
  try {
    if (modern) {
      const items = await clipboard.read();
      return [...new Set(items.flatMap((i) => i.types || []))];
    }
    return clipboard.availableFormats();
  } catch {
    return [];
  }
}

/** The picture on the clipboard as PNG bytes, or null. */
async function readImagePng() {
  try {
    if (modern) {
      for (const item of await clipboard.read()) {
        if (!(item.types || []).includes('image/png')) continue;
        const blob = await item.getType('image/png');
        const buf = Buffer.from(await blob.arrayBuffer());
        if (buf.length) return buf;
      }
      return null;
    }
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toPNG();
  } catch {
    return null;
  }
}

async function writeImagePng(png) {
  if (modern) {
    await clipboard.write([new electron.ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return;
  }
  clipboard.writeImage(electron.nativeImage.createFromBuffer(png));
}

/** True when the clipboard holds data in the named native format (Windows format name). */
async function hasNative(format) {
  try {
    if (modern) return Boolean(await clipboard.has(`electron application/osclipboard;format="${format}"`));
    return Boolean(clipboard.has(format));
  } catch {
    return false;
  }
}

module.exports = { readText, writeText, types, readImagePng, writeImagePng, hasNative, modern };
