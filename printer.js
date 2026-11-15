/* Mewanagar Voter Slip — Bluetooth thermal printing.
   Connects to Bluetooth Low Energy (BLE) thermal printers through Web Bluetooth (Chrome on Android),
   draws the slip as a black-and-white image (so Hindi always prints correctly, even on printers
   with no Devanagari font) and sends it with standard ESC/POS commands. */
"use strict";

/* BLE services used by common portable thermal printers (Chinese generic, Xprinter, GOOJPRT,
   MTP/PT series, Rongta, HPRT, Zjiang, Bixolon, etc.). Web Bluetooth only lets the page use
   services listed here. */
const PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000ae30-0000-1000-8000-00805f9b34fb",
  "0000ae3a-0000-1000-8000-00805f9b34fb",
  "0000ffb0-0000-1000-8000-00805f9b34fb",
  "0000fee7-0000-1000-8000-00805f9b34fb",
  "0000ff12-0000-1000-8000-00805f9b34fb",
  "0000af30-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  "0000180a-0000-1000-8000-00805f9b34fb"
];
/* Characteristics known to accept print data, tried first */
const PREFERRED_WRITE = [
  "00002af1-0000-1000-8000-00805f9b34fb",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
  "0000ff02-0000-1000-8000-00805f9b34fb",
  "0000fff2-0000-1000-8000-00805f9b34fb",
  "0000ffe1-0000-1000-8000-00805f9b34fb",
  "0000ae01-0000-1000-8000-00805f9b34fb",
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class BlePrinter extends EventTarget {
  constructor(){
    super();
    this.device = null; this.char = null; this.notifyChar = null;
    this.state = "none";          // none | connecting | connected | disconnected
    this.lastStatus = null;
    this.chunk = 180;
    this._onDisc = () => { this.char = null; this.notifyChar = null; this._set("disconnected"); };
  }
  get supported(){ return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  get name(){ return this.device ? (this.device.name || "Unnamed printer") : (lsGet("printerName") || ""); }
  _set(st, msg){ this.state = st; this.dispatchEvent(new CustomEvent("change", {detail: {state: st, msg}})); }

  /* First-time connect: shows Chrome's device chooser (needs a tap) */
  async choose(){
    if (!this.supported) throw new Error("NOBT");
    const dev = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: PRINTER_SERVICES});
    await this._use(dev);
  }
  /* Reconnect to the printer used before, without the chooser if Chrome allows it */
  async reconnect(){
    if (this.device){ await this._use(this.device); return true; }
    if (navigator.bluetooth && navigator.bluetooth.getDevices){
      const id = lsGet("printerId");
      const list = await navigator.bluetooth.getDevices();
      const dev = list.find(d => d.id === id) || list.find(d => d.name && d.name === lsGet("printerName"));
      if (dev){ await this._use(dev); return true; }
    }
    return false;
  }
  async _use(dev){
    if (this.device && this.device !== dev) this.device.removeEventListener("gattserverdisconnected", this._onDisc);
    this.device = dev;
    dev.removeEventListener("gattserverdisconnected", this._onDisc);
    dev.addEventListener("gattserverdisconnected", this._onDisc);
    this._set("connecting");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++){
      try{
        const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
        await this._findChars(server);
        lsSet("printerId", dev.id); lsSet("printerName", dev.name || "Unnamed printer");
        this._set("connected");
        return;
      } catch(e){ lastErr = e; await sleep(600); }
    }
    this._set("disconnected", lastErr && lastErr.message);
    throw lastErr;
  }
  async _findChars(server){
    const services = await server.getPrimaryServices();
    const writable = [], notifiable = [];
    for (const s of services){
      let chars = [];
      try{ chars = await s.getCharacteristics(); }catch(e){ continue; }
      for (const c of chars){
        if (c.properties.write || c.properties.writeWithoutResponse) writable.push(c);
        if (c.properties.notify) notifiable.push(c);
      }
    }
    if (!writable.length) throw new Error("NOWRITE");
    writable.sort((a, b) => rank(a) - rank(b));
    this.char = writable[0];
    this.notifyChar = notifiable.find(n => n.service.uuid === this.char.service.uuid) || null;
    function rank(c){ const i = PREFERRED_WRITE.indexOf(c.uuid); return i < 0 ? 99 : i; }
  }
  disconnect(){ if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }
  forget(){
    this.disconnect();
    if (this.device && this.device.forget) this.device.forget().catch(() => {});
    this.device = null; lsDel("printerId"); lsDel("printerName"); this._set("none");
  }

  async ensure(){
    if (this.char && this.device && this.device.gatt.connected) return;
    if (!(await this.reconnect())) throw new Error("NOTCONNECTED");
  }

  /* Best-effort paper check using ESC/POS real-time status (DLE EOT 4). Many printers do not
     answer over BLE; then we simply print. Returns "paper-out" | "ok" | "unknown". */
  async paperStatus(){
    if (!this.notifyChar) return "unknown";
    let got = null;
    const h = e => { const v = e.target.value; if (v && v.byteLength) got = v.getUint8(0); };
    try{
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener("characteristicvaluechanged", h);
      await this._write(new Uint8Array([0x10, 0x04, 0x04]), 0);
      for (let i = 0; i < 6 && got === null; i++) await sleep(50);
    } catch(e){ return "unknown"; }
    finally{
      this.notifyChar.removeEventListener("characteristicvaluechanged", h);
      try{ await this.notifyChar.stopNotifications(); }catch(e){}
    }
    if (got === null || (got & 0x93) !== 0x12) return "unknown";   // not a valid status byte
    return (got & 0x60) ? "paper-out" : "ok";
  }

  async _write(bytes, delay){
    const c = this.char;
    const noResp = c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === "function";
    let size = this.chunk;
    for (let i = 0; i < bytes.length; ){
      const part = bytes.subarray(i, i + size);
      try{
        if (noResp) await c.writeValueWithoutResponse(part);
        else if (typeof c.writeValueWithResponse === "function") await c.writeValueWithResponse(part);
        else await c.writeValue(part);
      } catch(e){
        // chunk too large for this printer's link: drop to the BLE minimum and retry
        if (size > 20 && /length|size|large|mtu|invalid/i.test(e.message || "")){ size = 20; this.chunk = 20; continue; }
        throw e;
      }
      i += part.length;
      if (delay) await sleep(delay);
    }
  }
  async send(bytes, speed){
    await this.ensure();
    const delay = {fast: 3, normal: 12, slow: 30}[speed] ?? 12;
    if (speed === "slow") this.chunk = Math.min(this.chunk, 100);
    try{ await this._write(bytes, delay); }
    catch(e){ if (!this.device.gatt.connected) this._onDisc(); throw e; }
  }
}

/* =====================================================================
   Slip image: draws the slip on a canvas at the printer's dot width
   (8 dots per mm, the usual 203 dpi), then makes it pure black & white.
   ===================================================================== */
/* ---- Election details printed on every slip (change here if needed) ---- */
const BALLOT_NO = "7";
const SYMBOL_NAME = "भिंडी";
/* Election symbol (भिंडी) as black-and-white pictures sized for 80 mm and 58 mm printers */
const SYMBOL_SRC = {
  s80: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAH8AAACwAQAAAAAOeIzfAAAFUElEQVR42m2Wv28cxxXHPzM38G4Q5Th2RQEH3gp2kdJwdRYIcQOwyJ9BxClSxWcnhQQo5JA2YFUmXQYwHP0PaVIY4iohpCuCKOkNYnU6g6niPdIAh854nou9H3Nnb3N333v75jtv3vt+B1k+xyISlbB4cg+il7/bv1qgAKBcANIs49oI3+ZYAuV6xFfrQPtUC0DZ9YhzgNjCIiLymYhI+IuIxDbi+ieThgTY/RFTB6gE0NWCf7JbnQCqBpoECENgkgB2AIwAznTKAXjSUr96KSL9YxGZM91wSAFgZ8Ctx8SyBHljBuimZRbfmgHKE1z71wkA04BXn0P4NR0RkavqTWnoiEy/aEt2xVSaLSUy3dI44Pueo0MJl4V2jwF+k0HxNrxC7/0XoKpoyKEqtd0GUMYRgdcwt86BDjUdPJyMtb52EOsjwCE9tPq2AlxTUcJ3JZqjGjIUNRp/iObdBmgGdQT+49H07oOpcHmAZ6DpbgO+1+AaeaTRZFttqStFfBs0HAO1HdzChBFoTO5QIQJwA0jc3hF58+bi9vRi6v4QNUrX0EiA+vLzx2h4+TvYx24CHdDg7kJu/oTOX/UbNDR9RwManpUtg80TROclEPdA5EXVkX/GwXuvXmyGq2iAUsGhcZzeDmDgenMPqA2gmp9riG/hvoM9uu940BD+fgbVEYTf6gkaisNxVdCM6hua0Ww8agXgRhNAZLxzfHzRf7HxotN/3o8aVD0g4C0dRqDBDBngCkdebBRowPd6lkDVLfdLNISyCw2NhIOi3Vwv61LaslsQHAZ+ochuiD68G9vt558Yhwc+DA8AkTCI2w+e31y8/g9/JVGDNg4KCZfmpi2cGj8dnwasGTWTdpVhrWpMzE/0bIAUQ2M52GAyAgMMhoMh5IUa2TaiGMC+5l6JayMCvbt/5ezLrH+njej2bAHcl2IxlTGcKhQz6mTdzBr0Zdx2raD4Gz/dlq3Me5GIiIT74UHv4IuNZjpXGIOAQl3Okurq6OyIxl4uZl/DsILJhJaYqp+OobRVPliKkloRx0M+8LVvTk7mQFMD7PSLWQ5K+8uHveJrmAO+gQZ/rzMHoIAQHmZzoMjDvS53fLZUOou3rdQZgFDEfhb1ZXceYUNOwE4S+RTr8kSTowVLTHQ9mkdROFkkzYER2VIzRTRiErMAzmrcci8GhXHGJRFuPP/Wfji4pFpGaF190NJKhP5GpSL9lNLVSYSi9sHVy71QU5SNS3MMQyzV6rKFT4W+KS1QJ7bmo/TKFePLbespc/foCZ+mTAPkMwdtT85iwvPWT1ogwsczwzAzH9VMbFJCEaoV6sahdfTJXswhvlq1tZcqT7wMXblQr9pa05VkWaY17nq1yOW1CQkPP/S7f0tPrigLj02Ang/6PMkRY487SUvBDjZM0wLl3Wh/f54Qs5/kbc/NfH9qB35a/Xnp+/oN43LTLF/55uvx2UHvNCnQToPRyebOn/1/XH37ZRJxKwxRSYEqCqXzr9wCyDfjoD49SvrjHek5k/r+BDdlv1o0P+Xuv8rxr5bL3snJPKf9xURxQl0cpo1b1H98mDRd0KW5++/SNWkH9c6TlvK5U5L7pD9+FrHvF+0tRkSk7gTlzy7qbCZsUmfho7D7Xp3NS1jnWH1ubUgOu1H/e7Ic9coCvl4eAzshk0e3Q2dxDGWA7W/Wrl9b6Dh7JSI+k6mJav6KghzhMJVPyPdxKznMk0rP9dQA6Jdxd9EO4vsi9JftMKO/dg18tEKsgO10Xl4rYSsse0xERGq1lvT19btldrAGmMotB6gdM1mNUD+69Lp1YG8d2CyBHwA3LomOmFwNIAAAAABJRU5ErkJggg==",
  s58: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAACQAQAAAADMphN4AAAEG0lEQVR42lWV32scVRTHP3N2yE5lSKYV7KaGZmqFiE/bFiWV1I6l0EJBwT9AViLoY5Q+tFLSSSwKoml8FB+6UHz3D5B0UgVTkDaPgqWdSmCj+GO6CXR2O73Hh/m1GbgPnznn3jPnzjnfg5bPtKoK5ZMAAtAFNABQVZ1QVfNO6ZmW3gLgA2yWxB7b33so3EOmWHmEO6qa3Sgj6B7PrFhFvBAsvyQB0rAkKxp5jRvDbgf6+ZctQAz8l9MsbABxTofAA5ycDoZ027Cekx0pwJdcV9WdeNpwTvUoTVXdadzIaKqZkSGgXsLbGeaVRhgFpOmFg38+fU9flSDKk/HaZJtybBOk0cqAAdK8BIAF9EOx74MVfYVZYMsXuQtjAl2b84jVA1gDdCIQLoY03neGYDoIb0TAQ2A3xOZIDAtfKyQrluAuIAGc2o67CGYWOH4R3G0E5xD8BvDjfQQ9GFqka7DfgGbZtM703MG9E/FVgcY2bsbwXrKFwOUBHW8Vc/Y5BNluAc/gowiBnh2OmYQsGgc1Eyunvx3c2flmelYFOBlDuntg2kIg9cMTDWGeWQSmsgR8zJsCao49/uXXbL7nZj0VOOf4suzhZjECP2sG9CYHDoIVX1tpsWbOSITAJ7cda93JLiYeAifjW4AV2yECU0tbIfPDjZ6PgJcsuzGRFwUImNkkCrnWHQcbmr7zPcebdH9CwM5aMYyfzvLKWsk+b1v+4kkQEMdrkz5jObfdMuCnWQI2WLbzYoN3B3Zu63wG2LKdk+DiOrsR2EC7u7uzGsRebrNwPNjo5rbUip4aJoq69ju2cVqLQU4ZHQf1w5y8hBgzV3ZA0G9odrkgQ5DYnhTktAZg7VZ960soMWApDP/iZvr0hYXc1vA8Iry6w0/l8mADjMGjYbPu8MOhHRQkqkXTC4Bt046r3oy4znJps2S5EJUigtNNKorXoyyoaAl704pqzziXEBug3dHvWiOn8LA+M02O2XQqDQlIrozoSypedYpnc+mfUZWy1ipyMnfOaZfU8DCdOt6iGdEscZzpndp2C+ocsBsHLrVK5TNTV/ovf1ipcJ8vHtTRl26zWu9LY/03KvcNGjfm7sxU+/yE1C09B2b2j5tVtsz4YVYp7ZYzv3L8+WqfN/6Web30vD+5ke6Lyptwkif+w7SoCZbWL/z+2gdaeHrnP3XrbD/2pqJ+FeHI5NHJu1zNI+gj34RWfS9B70Sr9MwYuGd74eniW/bpmQdh6ZkNh+uJG9R/07sa+XEh+DY8qWvJMcyNlfWZeHA4IckpBn9cnZFZta+eJEFCI7SLbKPwUcBaWtgCQKKyVyzAMusFvQSwyg85TQHMxkGRu8aq0UR1u/uL+Ug5bvvN0XnbzEbnpi6Wdw3wzNYRm4zWNdYeIhqNoImq/g87Od4OI+F+ogAAAABJRU5ErkJggg=="
};
const SYMBOL = {};
const SYMBOL_READY = Promise.all(Object.entries(SYMBOL_SRC).map(([k, src]) => new Promise(res => {
  const im = new Image(); im.onload = () => { SYMBOL[k] = im; res(); }; im.onerror = () => res(); im.src = src;
})));

const SLIP_FONT = '"Noto Sans Devanagari","Nirmala UI","Mangal",Roboto,Arial,sans-serif';
const graphemes = s => (typeof Intl !== "undefined" && Intl.Segmenter)
  ? Array.from(new Intl.Segmenter("hi", {granularity: "grapheme"}).segment(s), x => x.segment)
  : Array.from(s);

function wrapText(ctx, text, maxW){
  text = String(text || "");
  if (!text) return [""];
  const words = text.split(/(\s+|\/)/).filter(w => w !== "");
  const lines = []; let cur = "";
  const fit = s => ctx.measureText(s).width <= maxW;
  for (const w of words){
    const trial = cur + w;
    if (fit(trial)){ cur = trial; continue; }
    if (cur.trim()) { lines.push(cur.trimEnd()); cur = ""; }
    const piece = w.trimStart();
    if (fit(piece)){ cur = piece; continue; }
    for (const g of graphemes(piece)){           // a single very long word: break between letters
      if (fit(cur + g)) cur += g; else { if (cur) lines.push(cur); cur = g; }
    }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}

/* Returns {canvas, width, height, bits: Uint8Array (1 = black), widthBytes} */
function renderSlip(rec, opt){
  const W = opt.dots;                     // printable dots per line, e.g. 384 (58 mm) / 576 (80 mm)
  const mm = W / (opt.paper === "80" ? 72 : 48);   // dots per mm of printable width
  const k = (opt.size === "l" ? 1.15 : 1);
  const pt = v => Math.round(v * 0.3528 * mm * k);  // points -> dots
  const wide = opt.paper === "80";
  const F = {
    name: pt(wide ? 13 : 11.5), val: pt(wide ? 11 : 10), lbl: pt(wide ? 9 : 7.5),
    vm: pt(wide ? 9.5 : 8.5), gp: pt(wide ? 7.5 : 7), ty: pt(wide ? 9 : 8), hd: pt(wide ? 15 : 13)
  };
  const padX = Math.round(mm * 0.5);
  const lblW = Math.round(mm * (wide ? 31 : 21));
  const gap = Math.round(mm * 1.2);
  const valX = padX + lblW + gap, valW = W - valX - padX;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = 2000;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = "#000"; ctx.textBaseline = "alphabetic";

  let y = Math.round(mm * 1);
  // heading: मतदाता पर्ची (bold, centred)
  {
    ctx.font = `800 ${F.hd}px ${SLIP_FONT}`;
    const t = "मतदाता पर्ची", w = ctx.measureText(t).width;
    y += Math.round(F.hd * 1.1);
    ctx.fillText(t, Math.round((W - w) / 2), y);
    y += Math.round(F.hd * 0.35);
    ctx.fillRect(padX, y, W - 2 * padX, Math.max(2, Math.round(mm * 0.3)));
    y += Math.round(mm * 1.2);
  }
  const rows = opt.test ? [
    ["NAME:", "TEST PRINT परीक्षण", "name"],
    ["FATHER/HUSBAND NAME:", "हिंदी अक्षर: क्ष त्र ज्ञ श्र ऋ ॐ ड़ ढ़"],
    ["WARD:", "4"], ["GENDER:", "पुरूष"], ["AGE:", "45"], ["CASTE:", "जाति"],
    ["S.N.:", "123"], ["EPIC:", "ABC1234567"], ["BOOTH NO.:", "74"]
  ] : [
    ["NAME:", rec.name, "name"],
    ["FATHER/HUSBAND NAME:", rec.father],
    ["WARD:", rec.ward], ["GENDER:", rec.gender], ["AGE:", rec.age],
    ["CASTE:", rec.caste], ["S.N.:", rec.sn], ["EPIC:", rec.epic],
    ["BOOTH NO.:", rec.booth]
  ];
  for (const [label, value, kind] of rows){
    const vSize = kind === "name" ? F.name : F.val;
    ctx.font = `700 ${F.lbl}px ${SLIP_FONT}`;
    const lLines = wrapText(ctx, label, lblW);
    ctx.font = `${kind === "name" ? 800 : 400} ${vSize}px ${SLIP_FONT}`;
    const vLines = wrapText(ctx, value, valW);
    const vLH = Math.round(vSize * 1.32), lLH = Math.round(F.lbl * 1.25);
    const base = y + Math.round(vSize * 1.02);   // room for Hindi vowel signs above the line
    vLines.forEach((t, i) => ctx.fillText(t, valX, base + i * vLH));
    ctx.font = `700 ${F.lbl}px ${SLIP_FONT}`;
    lLines.forEach((t, i) => ctx.fillText(t, padX, base + i * lLH));
    const h = Math.max(vLines.length * vLH, (lLines.length - 1) * lLH + vLH);
    y += h + Math.round(mm * 0.5);
  }
  // thin separator
  y += Math.round(mm * 0.6);
  ctx.fillRect(padX, y, W - 2 * padX, Math.max(2, Math.round(mm * 0.3)));
  y += Math.round(mm * 1.2);
  // ---- ballot number + election symbol ----
  {
    const sym = SYMBOL[wide ? "s80" : "s58"] || SYMBOL.s80 || null;
    const iw = sym ? sym.naturalWidth : 0, ih = sym ? sym.naturalHeight : 0;
    const gapI = Math.round(mm * 3);
    const maxTW = W - 2 * padX - (sym ? iw + gapI : 0);
    const t1 = `BALLOT NO.: ${BALLOT_NO}`, t2 = `चुनाव चिन्ह: ${SYMBOL_NAME}`;
    let s1 = F.hd, s2 = F.name;
    const widthAt = (t, sz) => { ctx.font = `800 ${sz}px ${SLIP_FONT}`; return ctx.measureText(t).width; };
    while ((widthAt(t1, s1) > maxTW || widthAt(t2, s2) > maxTW) && s2 > 10){ s1 = Math.round(s1 * 0.93); s2 = Math.round(s2 * 0.93); }
    const tw = Math.max(widthAt(t1, s1), widthAt(t2, s2));
    const th = Math.round(s1 * 1.25 + s2 * 1.45);
    const blockH = Math.max(ih, th);
    const x0 = Math.round((W - (tw + (sym ? gapI + iw : 0))) / 2);
    let ty = y + Math.round((blockH - th) / 2);
    ctx.font = `800 ${s1}px ${SLIP_FONT}`; ty += Math.round(s1 * 1.0); ctx.fillText(t1, x0, ty);
    ctx.font = `800 ${s2}px ${SLIP_FONT}`; ty += Math.round(s2 * 1.4); ctx.fillText(t2, x0, ty);
    if (sym){ ctx.imageSmoothingEnabled = false; ctx.drawImage(sym, x0 + tw + gapI, y + Math.round((blockH - ih) / 2)); }
    y += blockH + Math.round(mm * 1.2);
    ctx.fillRect(padX, y, W - 2 * padX, Math.max(2, Math.round(mm * 0.3)));
    y += Math.round(mm * 1.2);
  }
  const center = (txt, size, weight, spacing) => {
    ctx.font = `${weight} ${size}px ${SLIP_FONT}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = spacing || "0px";
    const w = ctx.measureText(txt).width;
    y += Math.round(size * 1.05);
    ctx.fillText(txt, Math.round((W - w) / 2), y);
    y += Math.round(size * 0.3);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  };
  center("वन्दे मातरम्", F.vm, 700);
  center("ग्राम पंचायत मेवानगर", F.gp, 700);
  if (opt.test){
    y += Math.round(mm * 1.5);
    ctx.fillRect(0, y, W, 2); ctx.fillRect(0, y, 2, mm * 4); ctx.fillRect(W - 2, y, 2, mm * 4);
    for (let x = 0; x < W; x += Math.round(mm * 10)) ctx.fillRect(x, y, 2, mm * 2);
    y += Math.round(mm * 4);
    ctx.font = `400 ${F.lbl}px ${SLIP_FONT}`;
    const t = `${W} dots · ${opt.paper} mm · edge marks must both print`;
    y += F.lbl; ctx.fillText(t, Math.max(0, (W - ctx.measureText(t).width) / 2), y);
  }
  const H = Math.ceil(y + mm * 1.5);

  // to 1-bit
  const img = ctx.getImageData(0, 0, W, H).data;
  const widthBytes = Math.ceil(W / 8);
  const bits = new Uint8Array(widthBytes * H);
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const octx = out.getContext("2d"); const od = octx.createImageData(W, H);
  for (let yy = 0; yy < H; yy++){
    for (let x = 0; x < W; x++){
      const i = (yy * W + x) * 4;
      const lum = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
      const black = lum < 150;
      if (black) bits[yy * widthBytes + (x >> 3)] |= (0x80 >> (x & 7));
      const v = black ? 0 : 255; od.data[i] = od.data[i + 1] = od.data[i + 2] = v; od.data[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return {canvas: out, width: W, height: H, bits, widthBytes};
}

/* ESC/POS job for one or more slips */
function escposJob(images, opt){
  const parts = [];
  const push = a => parts.push(a instanceof Uint8Array ? a : new Uint8Array(a));
  push([0x1B, 0x40]);                        // initialise
  for (const im of images){
    if (opt.mode === "escstar") pushEscStar(im, push);
    else pushGSv0(im, push);
    push([0x1B, 0x64, Math.max(0, Math.min(10, opt.feed ?? 3))]);   // feed n lines
    if (opt.cut) push([0x1D, 0x56, 0x42, 0x00]);
  }
  let len = 0; for (const p of parts) len += p.length;
  const all = new Uint8Array(len); let o = 0;
  for (const p of parts){ all.set(p, o); o += p.length; }
  return all;
}
function pushGSv0(im, push){
  const band = 128;
  for (let y0 = 0; y0 < im.height; y0 += band){
    const h = Math.min(band, im.height - y0);
    push([0x1D, 0x76, 0x30, 0x00, im.widthBytes & 0xFF, im.widthBytes >> 8, h & 0xFF, h >> 8]);
    push(im.bits.subarray(y0 * im.widthBytes, (y0 + h) * im.widthBytes));
  }
}
function pushEscStar(im, push){
  push([0x1B, 0x33, 24]);                    // line spacing = 24 dots
  const W = im.width;
  for (let y0 = 0; y0 < im.height; y0 += 24){
    const row = new Uint8Array(5 + W * 3 + 1);
    row.set([0x1B, 0x2A, 33, W & 0xFF, W >> 8]);
    for (let x = 0; x < W; x++){
      for (let b = 0; b < 3; b++){
        let byte = 0;
        for (let bit = 0; bit < 8; bit++){
          const yy = y0 + b * 8 + bit;
          if (yy < im.height && (im.bits[yy * im.widthBytes + (x >> 3)] & (0x80 >> (x & 7)))) byte |= (0x80 >> bit);
        }
        row[5 + x * 3 + b] = byte;
      }
    }
    row[row.length - 1] = 0x0A;
    push(row);
  }
  push([0x1B, 0x32]);                        // default line spacing
}
