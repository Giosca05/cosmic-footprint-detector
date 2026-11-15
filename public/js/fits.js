/*
 * fits.js: lettore FITS minimale (nessuna dipendenza).
 * Unica responsabilità: da un ArrayBuffer FITS ricavare l'immagine 2-D (HDU 'IMAGE',
 * oppure la prima estensione 2-D). Funzione globale: parseFits(buffer).
 * Non usa il WCS: l'allineamento dei fotogrammi si affida al fatto che i ritagli
 * sono centrati sulla stessa posizione richiesta.
 */
const FITS_BLOCK = 2880;

function parseFitsHeader(bytes, start) {
  const dec = new TextDecoder("ascii");
  const header = {};
  let pos = start, done = false;
  while (!done && pos + FITS_BLOCK <= bytes.length) {
    for (let i = 0; i < 36; i++) {
      const card = dec.decode(bytes.subarray(pos + i * 80, pos + (i + 1) * 80));
      const key = card.slice(0, 8).trim();
      if (key === "END") { done = true; break; }
      if (card[8] !== "=") continue;
      let val = card.slice(10).trim();
      if (val[0] === "'") {
        val = val.slice(1, val.indexOf("'", 1)).trim();
      } else {
        val = val.split("/")[0].trim();
        if (val === "T") val = true; else if (val === "F") val = false;
        else if (val !== "" && !isNaN(Number(val))) val = Number(val);
      }
      header[key] = val;
    }
    pos += FITS_BLOCK;
  }
  return { header: header, dataStart: pos };
}

function readImage(bytes, header, dataStart) {
  const w = header.NAXIS1, h = header.NAXIS2, bitpix = header.BITPIX, n = w * h;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
  const out = new Float32Array(n);
  const bscale = header.BSCALE === undefined ? 1 : header.BSCALE;
  const bzero = header.BZERO === undefined ? 0 : header.BZERO;
  const step = Math.abs(bitpix) / 8;
  for (let i = 0; i < n; i++) {
    const o = i * step;
    let v;
    if (bitpix === -32) v = view.getFloat32(o, false);
    else if (bitpix === -64) v = view.getFloat64(o, false);
    else if (bitpix === 16) v = view.getInt16(o, false);
    else if (bitpix === 32) v = view.getInt32(o, false);
    else if (bitpix === 8) v = view.getUint8(o);
    else throw new Error("BITPIX non supportato: " + bitpix);
    out[i] = v * bscale + bzero;
  }
  return { width: w, height: h, data: out, header: header };
}

/** FLAGS: bitmap per pixel (int) dell'estensione 'FLAGS', se presente. */
function readFlags(bytes, header, dataStart) {
  const w = header.NAXIS1, h = header.NAXIS2, bitpix = header.BITPIX, n = w * h;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
  const out = new Int32Array(n), step = Math.abs(bitpix) / 8;
  for (let i = 0; i < n; i++) {
    const o = i * step;
    out[i] = bitpix === 32 ? view.getInt32(o, false) : bitpix === 16 ? view.getUint16(o, false) : bitpix === 8 ? view.getUint8(o) : 0;
  }
  return out;
}

/** @returns {{width:number,height:number,data:Float32Array,header:Object,flags:(Int32Array|undefined)}} */
function parseFits(buffer) {
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode.apply(null, bytes.subarray(0, 6)) !== "SIMPLE") {
    throw new Error("Non è un file FITS");
  }
  let pos = 0, firstImage = null, result = null, flags = null;
  while (pos < bytes.length) {
    const hdu = parseFitsHeader(bytes, pos);
    const hd = hdu.header, naxis = hd.NAXIS || 0;
    let size = 0;
    if (naxis > 0) {
      size = Math.abs(hd.BITPIX) / 8;
      for (let k = 1; k <= naxis; k++) size *= hd["NAXIS" + k];
    }
    if (naxis === 2) {
      if (hd.EXTNAME === "IMAGE" && !result) result = readImage(bytes, hd, hdu.dataStart);
      else if (hd.EXTNAME === "FLAGS" && !flags) { try { flags = readFlags(bytes, hd, hdu.dataStart); } catch (e) { flags = null; } }
      else if (!firstImage && hd.EXTNAME !== "FLAGS") firstImage = { hd: hd, start: hdu.dataStart };
    }
    pos = hdu.dataStart + Math.ceil(size / FITS_BLOCK) * FITS_BLOCK;
  }
  if (!result && firstImage) result = readImage(bytes, firstImage.hd, firstImage.start);
  if (!result) throw new Error("Nessuna immagine 2-D nel FITS");
  if (flags && flags.length === result.width * result.height) result.flags = flags;
  return result;
}
