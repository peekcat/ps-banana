// ============================================================
//  cv-psio.js — 轮椅幕布 自带的 PS 抓选区 / 贴回能力
//  从主插件 host/ps-io.js + host/ps-pixels.js 按原文移植 (sed 抽取, 未手改逻辑)。
//  解耦点: state.* 换成独立幕布的固定配置; logToPanel → console.log。
//  暴露 window.CV_PSIO = { getSelectionAndImage, placeImageToSpecificDoc }
// ============================================================
(function () {
'use strict';

var photoshop = null, app = null, core = null, imaging = null, uxpModule = null, storage = null, fs = null;
try {
    photoshop = require('photoshop');
    app = photoshop.app; core = photoshop.core; imaging = photoshop.imaging;
    uxpModule = require('uxp');
    storage = uxpModule.storage;
    fs = storage.localFileSystem;
} catch (e) { /* 非 UXP 环境(纯语法检查时) */ }

// 独立幕布的配置 (替代主插件注入的全局 state)
var state = {
    getAntiTruncationMode: function () { return 0; },                 // 幕布抓图不做抗截断
    getMaxResolution: function () { return 4096; },                   // 抓图长边上限(可调)
    getAutoSelectFullCanvasNoSelection: function () { return true; }, // 没选区就用全图
    getColorStable: function () { return false; }                     // 不开色彩稳定(免 sRGB 注入复杂度)
};
function logToPanel(msg, level) { try { console.log('[幕布psio]', msg); } catch (e) {} }

// ===== 以下像素工具来自 host/ps-pixels.js (第 13-282 行, 原文) =====
function arrayBufferToBase64(buffer) {
    // 分块 apply (避免 4K+ 大图 byte-by-byte 字符串拼接 → V8 OOM/超慢)
    // 8K 一块: 8MB 数据从 ~30s → ~100ms
    var bytes = new Uint8Array(buffer);
    var chunks = [];
    var chunkSize = 8192;
    for (var i = 0; i < bytes.length; i += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
}

function base64ToArrayBuffer(base64) {
    var binary = atob(base64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// 色相偏移180°：快速算法 new = max + min - original
function pixelsHueShift180(data, pixelCount, comp) {
    for (var i = 0; i < pixelCount; i++) {
        var off = i * comp;
        var r = data[off], g = data[off + 1], b = data[off + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var s = mx + mn;
        data[off] = s - r; data[off + 1] = s - g; data[off + 2] = s - b;
    }
}

// 垂直翻转像素行
function pixelsFlipVertical(data, w, h, comp) {
    var rowBytes = w * comp;
    var tmp = new Uint8Array(rowBytes);
    for (var y = 0, yEnd = Math.floor(h / 2); y < yEnd; y++) {
        var topOff = y * rowBytes, botOff = (h - 1 - y) * rowBytes;
        tmp.set(data.subarray(topOff, topOff + rowBytes));
        data.copyWithin(topOff, botOff, botOff + rowBytes);
        data.set(tmp, botOff);
    }
}

// 纯JS JPEG编码器（Baseline，不依赖Canvas API）
// 输入: w,h,rgbData(Uint8Array, RGB或RGBA), comp(3或4), quality(1-100)
// 输出: Uint8Array (JPEG文件)
var encodeJPEGFromRGB = (function() {
    // 标准量化表
    var STD_QUANT_Y = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
    var STD_QUANT_C = [17,18,24,47,99,99,99,99,18,21,26,66,99,99,99,99,24,26,56,99,99,99,99,99,47,66,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99];
    // ZigZag 顺序
    var ZZ = [0,1,5,6,14,15,27,28,2,4,7,13,16,26,29,42,3,8,12,17,25,30,41,43,9,11,18,24,31,40,44,53,10,19,23,32,39,45,52,54,20,22,33,38,46,51,55,60,21,34,37,47,50,56,59,61,35,36,48,49,57,58,62,63];
    // DC/AC Huffman 表（标准）
    var DC_Y_BITS = [0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0], DC_Y_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
    var DC_C_BITS = [0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0], DC_C_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
    var AC_Y_BITS = [0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d], AC_Y_VALS = [0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa];
    var AC_C_BITS = [0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,0x77], AC_C_VALS = [0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,0xa1,0xb1,0xc1,0x09,0x23,0x33,0x52,0xf0,0x15,0x62,0x72,0xd1,0x0a,0x16,0x24,0x34,0xe1,0x25,0xf1,0x17,0x18,0x19,0x1a,0x26,0x27,0x28,0x29,0x2a,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x82,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa];

    function buildHuffTable(bits, vals) {
        var t = [], code = 0, vi = 0;
        for (var len = 1; len <= 16; len++) {
            for (var i = 0; i < bits[len-1]; i++) { t[vals[vi]] = { len: len, code: code }; code++; vi++; }
            code <<= 1;
        }
        return t;
    }
    function scaleQuant(std, q) {
        var s = q < 50 ? Math.floor(5000/q) : 200-q*2; s = Math.max(1,s);
        var r = new Int32Array(64);
        for (var i=0;i<64;i++) { var v=Math.floor((std[i]*s+50)/100); r[i]=Math.max(1,Math.min(255,v)); }
        return r;
    }
    var cosT = null;
    function initCos() {
        if(cosT) return;
        cosT = new Float64Array(64);
        for(var i=0;i<8;i++) for(var j=0;j<8;j++) cosT[i*8+j]=Math.cos((2*i+1)*j*Math.PI/16);
    }
    function fdct(block, quant, out) {
        initCos();
        for(var v=0;v<8;v++) for(var u=0;u<8;u++) {
            var s=0;
            for(var y=0;y<8;y++) for(var x=0;x<8;x++) s+=block[y*8+x]*cosT[x*8+u]*cosT[y*8+v];
            var cu=u===0?0.7071067811865476:1, cv=v===0?0.7071067811865476:1;
            out[ZZ[v*8+u]]=Math.round(s*0.25*cu*cv/quant[v*8+u]);
        }
    }

    return function encodeJPEG(w, h, rgbData, comp, quality) {
        comp = comp || 3; quality = quality || 95;
        var qY = scaleQuant(STD_QUANT_Y, quality), qC = scaleQuant(STD_QUANT_C, quality);
        var htDcY=buildHuffTable(DC_Y_BITS,DC_Y_VALS), htAcY=buildHuffTable(AC_Y_BITS,AC_Y_VALS);
        var htDcC=buildHuffTable(DC_C_BITS,DC_C_VALS), htAcC=buildHuffTable(AC_C_BITS,AC_C_VALS);

        var buf = new Uint8Array(w*h*3+65536), pos=0;
        var bitBuf=0, bitCnt=0;
        function wb(b){buf[pos++]=b;}
        function w16(v){wb(v>>8);wb(v&0xFF);}
        function wBits(code,len){bitBuf=(bitBuf<<len)|code;bitCnt+=len;while(bitCnt>=8){var b=(bitBuf>>>(bitCnt-8))&0xFF;wb(b);if(b===0xFF)wb(0);bitCnt-=8;}}
        function flushBits(){if(bitCnt>0)wBits(0x7F,7);bitCnt=0;bitBuf=0;}

        function encodeBlock(block,quant,prevDC,htDc,htAc){
            var dct=new Int32Array(64);
            fdct(block,quant,dct);
            var diff=dct[0]-prevDC;
            var absDiff=diff<0?-diff:diff, cat=0;
            var tmp=absDiff;while(tmp){cat++;tmp>>=1;}
            var h=htDc[cat];
            if(h)wBits(h.code,h.len);else wBits(0,1);
            if(cat){var bits=diff<0?diff+((1<<cat)-1):diff;wBits(bits,cat);}
            var zeros=0;
            for(var i=1;i<64;i++){
                if(dct[i]===0){zeros++;continue;}
                while(zeros>=16){var z=htAc[0xF0];if(z)wBits(z.code,z.len);zeros-=16;}
                var v=dct[i],av=v<0?-v:v,c=0;tmp=av;while(tmp){c++;tmp>>=1;}
                var sym=(zeros<<4)|c;
                var ha=htAc[sym];if(ha)wBits(ha.code,ha.len);else wBits(0,1);
                var bv=v<0?v+((1<<c)-1):v;wBits(bv,c);
                zeros=0;
            }
            if(zeros>0){var eob=htAc[0x00];if(eob)wBits(eob.code,eob.len);}
            return dct[0];
        }

        // SOI
        w16(0xFFD8);
        // APP0 (JFIF)
        w16(0xFFE0);w16(16);wb(0x4A);wb(0x46);wb(0x49);wb(0x46);wb(0);wb(1);wb(1);wb(0);w16(1);w16(1);wb(0);wb(0);
        // DQT Y
        w16(0xFFDB);w16(67);wb(0);for(var i=0;i<64;i++)wb(qY[ZZ[i]]);
        // DQT C
        w16(0xFFDB);w16(67);wb(1);for(var i=0;i<64;i++)wb(qC[ZZ[i]]);
        // SOF0
        w16(0xFFC0);w16(17);wb(8);w16(h);w16(w);wb(3);
        wb(1);wb(0x11);wb(0); // Y: 1x1, QT0
        wb(2);wb(0x11);wb(1); // Cb: 1x1, QT1
        wb(3);wb(0x11);wb(1); // Cr: 1x1, QT1
        // DHT
        function writeDHT(cls,id,bits,vals){w16(0xFFC4);var n=0;for(var i=0;i<16;i++)n+=bits[i];w16(19+n);wb((cls<<4)|id);for(var i=0;i<16;i++)wb(bits[i]);for(var i=0;i<n;i++)wb(vals[i]);}
        writeDHT(0,0,DC_Y_BITS,DC_Y_VALS);writeDHT(1,0,AC_Y_BITS,AC_Y_VALS);
        writeDHT(0,1,DC_C_BITS,DC_C_VALS);writeDHT(1,1,AC_C_BITS,AC_C_VALS);
        // SOS
        w16(0xFFDA);w16(12);wb(3);wb(1);wb(0x00);wb(2);wb(0x11);wb(3);wb(0x11);wb(0);wb(63);wb(0);

        var prevDcY=0,prevDcCb=0,prevDcCr=0;
        var blockY=new Float64Array(64),blockCb=new Float64Array(64),blockCr=new Float64Array(64);
        for(var by=0;by<h;by+=8)for(var bx=0;bx<w;bx+=8){
            for(var dy=0;dy<8;dy++)for(var dx=0;dx<8;dx++){
                var py=by+dy,px=bx+dx;
                if(py>=h)py=h-1;if(px>=w)px=w-1;
                var off=(py*w+px)*comp;
                var r=rgbData[off],g=rgbData[off+1],b=rgbData[off+2];
                var idx=dy*8+dx;
                blockY[idx]=0.299*r+0.587*g+0.114*b-128;
                blockCb[idx]=-0.1687*r-0.3313*g+0.5*b;
                blockCr[idx]=0.5*r-0.4187*g-0.0813*b;
            }
            prevDcY=encodeBlock(blockY,qY,prevDcY,htDcY,htAcY);
            prevDcCb=encodeBlock(blockCb,qC,prevDcCb,htDcC,htAcC);
            prevDcCr=encodeBlock(blockCr,qC,prevDcCr,htDcC,htAcC);
        }
        flushBits();
        // EOI
        w16(0xFFD9);
        return buf.slice(0,pos);
    };
})();

// 最小PNG编码器（无压缩store模式，RGB色彩类型2）
function encodePNGFromRGB(w, h, rgbData, comp, withSRGB) {
    comp = comp || 3;
    function u32be(a, o, v) { a[o]=(v>>>24)&0xFF; a[o+1]=(v>>>16)&0xFF; a[o+2]=(v>>>8)&0xFF; a[o+3]=v&0xFF; }
    var _ct = null;
    function crc32(buf, s, len) {
        if (!_ct) { _ct = new Uint32Array(256); for (var n=0;n<256;n++) { var c=n; for (var k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); _ct[n]=c; } }
        var crc = 0xFFFFFFFF; for (var i=s; i<s+len; i++) crc=_ct[(crc^buf[i])&0xFF]^(crc>>>8); return (crc^0xFFFFFFFF)>>>0;
    }
    // 构建raw扫描线数据: filter(0) + RGB*width 每行
    var rowB = 1 + w * 3, rawSz = rowB * h;
    var raw = new Uint8Array(rawSz);
    for (var y = 0; y < h; y++) {
        raw[y * rowB] = 0; // filter None
        for (var x = 0; x < w; x++) {
            var si = (y * w + x) * comp, di = y * rowB + 1 + x * 3;
            raw[di] = rgbData[si]; raw[di+1] = rgbData[si+1]; raw[di+2] = rgbData[si+2];
        }
    }
    // Deflate store块
    var MX = 65535, nBlk = Math.ceil(rawSz / MX);
    var dfSz = 2 + nBlk * 5 + rawSz + 4; // zlib头 + 块头 + 数据 + adler32
    var df = new Uint8Array(dfSz);
    df[0] = 0x78; df[1] = 0x01; var p = 2;
    for (var bi = 0; bi < nBlk; bi++) {
        var bStart = bi * MX, bLen = Math.min(MX, rawSz - bStart);
        df[p++] = (bi === nBlk - 1) ? 1 : 0;
        df[p++] = bLen & 0xFF; df[p++] = (bLen >> 8) & 0xFF;
        df[p++] = (~bLen) & 0xFF; df[p++] = ((~bLen) >> 8) & 0xFF;
        df.set(raw.subarray(bStart, bStart + bLen), p); p += bLen;
    }
    // Adler32
    var a1 = 1, a2 = 0;
    for (var ai = 0; ai < rawSz; ai++) { a1 = (a1 + raw[ai]) % 65521; a2 = (a2 + a1) % 65521; }
    var adl = ((a2 << 16) | a1) >>> 0;
    df[p++]=(adl>>>24)&0xFF; df[p++]=(adl>>>16)&0xFF; df[p++]=(adl>>>8)&0xFF; df[p++]=adl&0xFF;
    // PNG chunks
    var sig = new Uint8Array([137,80,78,71,13,10,26,10]);
    var ihdr = new Uint8Array(25);
    u32be(ihdr,0,13); ihdr[4]=73;ihdr[5]=72;ihdr[6]=68;ihdr[7]=82;
    u32be(ihdr,8,w); u32be(ihdr,12,h);
    ihdr[16]=8; ihdr[17]=2; ihdr[18]=0; ihdr[19]=0; ihdr[20]=0;
    u32be(ihdr,21,crc32(ihdr,4,17));
    var idat = new Uint8Array(4+4+dfSz+4);
    u32be(idat,0,dfSz); idat[4]=73;idat[5]=68;idat[6]=65;idat[7]=84;
    idat.set(df, 8); u32be(idat, 8+dfSz, crc32(idat,4,4+dfSz));
    var iend = new Uint8Array(12);
    u32be(iend,0,0); iend[4]=73;iend[5]=69;iend[6]=78;iend[7]=68;
    u32be(iend,8,crc32(iend,4,4));
    // 合并
    var total = sig.length + ihdr.length + idat.length + iend.length;
    var png = new Uint8Array(total); var off = 0;
    png.set(sig, off); off += sig.length;
    png.set(ihdr, off); off += ihdr.length;
    png.set(idat, off); off += idat.length;
    png.set(iend, off);
    if (withSRGB) png = injectSRGBChunkIntoPNG(png);
    return png;
}

// 给已编码好的 PNG 字节注入标准 sRGB chunk(在 IHDR 之后),让 PS placeEvent 置入时
// 识别为 sRGB 并自动转换到文档工作空间。非 PNG 或已带 sRGB/iCCP 标记则原样返回。
var _sRGBCrcTable = null;
function _sRGBCrc32(buf, s, len) {
    if (!_sRGBCrcTable) {
        _sRGBCrcTable = new Uint32Array(256);
        for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _sRGBCrcTable[n] = c; }
    }
    var crc = 0xFFFFFFFF;
    for (var i = s; i < s + len; i++) crc = _sRGBCrcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function injectSRGBChunkIntoPNG(png) {
    if (!png || png.length < 33) return png;
    // 校验 PNG 签名
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var i = 0; i < 8; i++) { if (png[i] !== sig[i]) return png; }
    // IHDR: 8(签名) + [4 长度][4 类型][len 数据][4 CRC]
    var ihdrLen = ((png[8] << 24) | (png[9] << 16) | (png[10] << 8) | png[11]) >>> 0;
    var ihdrEnd = 8 + 4 + 4 + ihdrLen + 4;
    if (ihdrEnd + 8 > png.length) return png;
    // 若 IHDR 之后已存在色彩标记块(sRGB/iCCP),不重复注入
    var nextType = String.fromCharCode(png[ihdrEnd + 4], png[ihdrEnd + 5], png[ihdrEnd + 6], png[ihdrEnd + 7]);
    if (nextType === 'sRGB' || nextType === 'iCCP') return png;
    // 构建 sRGB chunk: 长度=1, 类型'sRGB', 数据=渲染意图(0=知觉), CRC
    var chunk = new Uint8Array(13);
    chunk[0] = 0; chunk[1] = 0; chunk[2] = 0; chunk[3] = 1; // data length = 1
    chunk[4] = 115; chunk[5] = 82; chunk[6] = 71; chunk[7] = 66; // 'sRGB'
    chunk[8] = 0; // rendering intent: perceptual
    var crc = _sRGBCrc32(chunk, 4, 5); // type(4) + data(1)
    chunk[9] = (crc >>> 24) & 0xFF; chunk[10] = (crc >>> 16) & 0xFF; chunk[11] = (crc >>> 8) & 0xFF; chunk[12] = crc & 0xFF;
    // 拼接: [0..ihdrEnd) + chunk + [ihdrEnd..]
    var out = new Uint8Array(png.length + 13);
    out.set(png.subarray(0, ihdrEnd), 0);
    out.set(chunk, ihdrEnd);
    out.set(png.subarray(ihdrEnd), ihdrEnd + 13);
    return out;
}


// ===== getSelectionAndImage 来自 host/ps-io.js (第 41-529 行, 原文) =====
async function getSelectionAndImage(predefinedSelection) {
    var result = null;
    try {
        await core.executeAsModal(async function() {
            var doc = app.activeDocument;
            var selBounds;
            if (predefinedSelection) {
                selBounds = {
                    left: Math.round(predefinedSelection.left), top: Math.round(predefinedSelection.top),
                    right: Math.round(predefinedSelection.right), bottom: Math.round(predefinedSelection.bottom),
                    width: Math.round(predefinedSelection.width), height: Math.round(predefinedSelection.height)
                };
            } else {
                // === 多版本兼容选区检测（3种方法自动降级） ===
                var _selRetries = 2;
                var _selLastErr = null;
                var _selOk = false;
                logToPanel("[选区] 开始检测选区...(文档: " + doc.name + ", " + doc.width + "x" + doc.height + ")", "info");

                while (_selRetries >= 0 && !_selOk) {
                    // 方法1: DOM API doc.selection.bounds
                    logToPanel("[选区] 尝试方法1: DOM API doc.selection.bounds...", "info");
                    try {
                        var b = doc.selection.bounds;
                        if (b && typeof b.left === 'number' && typeof b.right === 'number'
                            && !isNaN(b.left) && !isNaN(b.right) && (b.right - b.left) > 0) {
                            selBounds = {
                                left: Math.round(b.left), top: Math.round(b.top),
                                right: Math.round(b.right), bottom: Math.round(b.bottom),
                                width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top)
                            };
                            _selOk = true;
                            logToPanel("[选区] 方法1成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                            break;
                        } else {
                            logToPanel("[选区] 方法1: bounds存在但无效 (left=" + (b && b.left) + " right=" + (b && b.right) + ")", "warn");
                        }
                    } catch (e1) { _selLastErr = e1; logToPanel("[选区] 方法1失败: " + (e1.message || e1), "warn"); }

                    // 方法2: batchPlay 读取选区（兼容更多PS版本）
                    if (!_selOk) {
                        logToPanel("[选区] 尝试方法2: batchPlay读取选区...", "info");
                        try {
                            var bpResult = await app.batchPlay([{
                                _obj: "get",
                                _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                            }], {});
                            if (bpResult && bpResult[0] && bpResult[0].selection) {
                                var sel = bpResult[0].selection;
                                // 尝试读取选区边界（可能是 rectangle 或 path 格式）
                                var sLeft, sTop, sRight, sBottom;
                                if (sel.left !== undefined) {
                                    sLeft = sel.left._value !== undefined ? sel.left._value : sel.left;
                                    sTop = sel.top._value !== undefined ? sel.top._value : sel.top;
                                    sRight = sel.right._value !== undefined ? sel.right._value : sel.right;
                                    sBottom = sel.bottom._value !== undefined ? sel.bottom._value : sel.bottom;
                                } else if (sel._obj === 'rectangle') {
                                    sLeft = sel.left._value; sTop = sel.top._value;
                                    sRight = sel.right._value; sBottom = sel.bottom._value;
                                }
                                if (sLeft !== undefined && sRight !== undefined && (sRight - sLeft) > 0) {
                                    selBounds = {
                                        left: Math.round(sLeft), top: Math.round(sTop),
                                        right: Math.round(sRight), bottom: Math.round(sBottom),
                                        width: Math.round(sRight - sLeft), height: Math.round(sBottom - sTop)
                                    };
                                    _selOk = true;
                                    logToPanel("[选区] 方法2成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                                    break;
                                } else {
                                    logToPanel("[选区] 方法2: selection属性存在但坐标无效", "warn");
                                }
                            } else {
                                logToPanel("[选区] 方法2: 未返回selection属性", "warn");
                            }
                        } catch (e2) { if (!_selLastErr) _selLastErr = e2; logToPanel("[选区] 方法2失败: " + (e2.message || e2), "warn"); }
                    }

                    // 方法3: 通过通道属性获取选区bounds
                    if (!_selOk) {
                        logToPanel("[选区] 尝试方法3: 通道属性获取选区bounds...", "info");
                        try {
                            var chResult = await app.batchPlay([{
                                _obj: "get",
                                _target: [{ _property: "bounds" }, { _ref: "channel", _enum: "channel", _value: "selection" }]
                            }], {});
                            if (chResult && chResult[0] && chResult[0].bounds) {
                                var cb = chResult[0].bounds;
                                var cbL = cb.left._value || cb.left;
                                var cbT = cb.top._value || cb.top;
                                var cbR = cb.right._value || cb.right;
                                var cbB = cb.bottom._value || cb.bottom;
                                if ((cbR - cbL) > 0) {
                                    selBounds = {
                                        left: Math.round(cbL), top: Math.round(cbT),
                                        right: Math.round(cbR), bottom: Math.round(cbB),
                                        width: Math.round(cbR - cbL), height: Math.round(cbB - cbT)
                                    };
                                    _selOk = true;
                                    logToPanel("[选区] 方法3成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                                    break;
                                } else {
                                    logToPanel("[选区] 方法3: bounds存在但无效", "warn");
                                }
                            } else {
                                logToPanel("[选区] 方法3: 未返回bounds属性", "warn");
                            }
                        } catch (e3) { if (!_selLastErr) _selLastErr = e3; logToPanel("[选区] 方法3失败: " + (e3.message || e3), "warn"); }
                    }

                    if (_selRetries > 0) {
                        await new Promise(function(r){ setTimeout(r, 200); });
                    }
                    _selRetries--;
                }

                if (!_selOk) {
                    if (state.getAutoSelectFullCanvasNoSelection()) {
                        var docW = Math.round(Number(doc.width) || 0);
                        var docH = Math.round(Number(doc.height) || 0);
                        if (docW > 0 && docH > 0) {
                            selBounds = {
                                left: 0, top: 0,
                                right: docW, bottom: docH,
                                width: docW, height: docH
                            };
                            _selOk = true;
                            logToPanel("[选区] 未检测到选区，已自动使用全图: " + docW + "x" + docH, "warn");
                        }
                    }
                }

                if (!_selOk) {
                    var errDetail = _selLastErr ? (_selLastErr.message || String(_selLastErr)) : "unknown";
                    var bitInfo = "";
                    try { bitInfo = " | 文档位深: " + (doc.bitsPerChannel || "未知") + "bit"; } catch(be) {}
                    var modeInfo = "";
                    try { modeInfo = " | 色彩模式: " + (doc.mode || "未知"); } catch(me) {}
                    var diagMsg = "未检测到活动选区\n"
                        + "① 请确认已使用矩形选框工具(M)建立选区\n"
                        + "② 三种检测方法均失败: " + errDetail + "\n"
                        + "③ 文档信息" + bitInfo + modeInfo + "\n"
                        + "④ 如果是16/32bit文档，请尝试: 图像→模式→8位/通道";
                    throw new Error("NO_SELECTION|" + diagMsg);
                }
            }

            // 计算目标尺寸（限制maxResolution）
            var tw = selBounds.width, th = selBounds.height;
            var MAX_EDGE = state.getMaxResolution();
            if (tw > MAX_EDGE || th > MAX_EDGE) {
                if (tw > th) { th = Math.round(th * (MAX_EDGE / tw)); tw = MAX_EDGE; }
                else { tw = Math.round(tw * (MAX_EDGE / th)); th = MAX_EDGE; }
            }

            // 检测文档位深度（16-bit/32-bit 需要特殊处理）
            var docBitDepth = 8;
            try {
                // 方法1: DOM属性 doc.bitsPerChannel
                var rawBpc = doc.bitsPerChannel;
                if (typeof rawBpc === 'number' && rawBpc > 0) {
                    docBitDepth = rawBpc;
                } else {
                    // 方法2: batchPlay 读取 depth 属性
                    var bpResult2 = await app.batchPlay([{
                        _obj: "get",
                        _target: [{ _property: "depth" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                    }], {});
                    if (bpResult2 && bpResult2[0] && bpResult2[0].depth) {
                        docBitDepth = bpResult2[0].depth;
                    }
                }
                // 方法3: batchPlay 读取 bitsPerChannel 属性（某些版本用此名）
                if (docBitDepth === 8 && rawBpc !== 8) {
                    try {
                        var bpResult3 = await app.batchPlay([{
                            _obj: "get",
                            _target: [{ _property: "bitsPerChannel" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                        }], {});
                        if (bpResult3 && bpResult3[0] && bpResult3[0].bitsPerChannel) {
                            var bpcVal = bpResult3[0].bitsPerChannel;
                            // 可能是枚举值：_value: "bitDepth8" / "bitDepth16" / "bitDepth32"
                            if (typeof bpcVal === 'object' && bpcVal._value) {
                                if (bpcVal._value === 'bitDepth16' || bpcVal._value === 'sixteenBits') docBitDepth = 16;
                                else if (bpcVal._value === 'bitDepth32' || bpcVal._value === 'thirtyTwoBits') docBitDepth = 32;
                                else docBitDepth = 8;
                            } else if (typeof bpcVal === 'number') {
                                docBitDepth = bpcVal;
                            }
                        }
                    } catch(e3) {}
                }
            } catch(e) { docBitDepth = 8; }
            var is16bit = (docBitDepth === 16);
            var is32bit = (docBitDepth === 32);
            console.log("[imaging] 文档位深: " + docBitDepth + "-bit" + (is16bit ? " (16bit模式)" : is32bit ? " (32bit模式)" : ""));
            if (is16bit || is32bit) {
                logToPanel("[提示] 当前文档为 " + docBitDepth + "-bit 模式，自动转换为 8-bit 像素输出", "info");
            }

            // === 色彩稳定模式 自检 ===
            // 开启后:抓图强制转 sRGB、回传标记 sRGB、16/32位走色彩修正路径;此处先读文档色彩空间并把任何异常打进日志
            var csOn = false;
            try { csOn = !!state.getColorStable(); } catch(eCS) { csOn = false; }
            var csProfileName = '';
            if (csOn) {
                logToPanel("[色彩稳定] 模式已开启,开始自检...", "info");
                try {
                    // 修崩溃(2026-07-10): 全量 get 会唤醒打印子系统, 坏打印机驱动会致 PS 崩溃 — 只取需要的两个属性
                    var bpProf = await app.batchPlay([
                        { _obj: "get", _target: [{ _property: "colorProfileName" }, { _ref: "document", _id: doc.id }] },
                        { _obj: "get", _target: [{ _property: "mode" }, { _ref: "document", _id: doc.id }] }
                    ], {});
                    var pf = bpProf && bpProf[0] ? (bpProf[0].colorProfileName !== undefined ? bpProf[0].colorProfileName : bpProf[0].profile) : null;
                    var md = bpProf && bpProf[1] ? bpProf[1].mode : null;
                    csProfileName = (typeof pf === 'string') ? pf : (pf && pf._value ? pf._value : '');
                    var modeName = (md && md._value) ? md._value : (typeof md === 'string' ? md : '未知');
                    logToPanel("[色彩稳定] 文档色彩空间: " + (csProfileName || '未读到') + " | 模式: " + modeName + " | 位深: " + docBitDepth + "-bit", "info");
                    if (csProfileName && csProfileName.indexOf('sRGB') === -1) {
                        logToPanel("[色彩稳定] ⚠ 文档非 sRGB(" + csProfileName + "),将在抓图时转 sRGB、回传时转回本空间(进出本应不偏)", "warn");
                    } else if (csProfileName && csProfileName.indexOf('sRGB') !== -1) {
                        logToPanel("[色彩稳定] ✓ 文档本身即 sRGB,色彩链路天然一致", "success");
                    }
                    if (modeName && modeName !== 'RGBColorMode' && modeName !== 'RGBColor' && modeName !== '未知') {
                        logToPanel("[色彩稳定] ⚠ 文档不是 RGB 模式(" + modeName + "),色彩稳定仅针对 RGB,当前模式结果以实拍为准", "warn");
                    }
                } catch(csReadErr) {
                    logToPanel("[色彩稳定] ✗ 自检读取文档色彩配置失败: " + (csReadErr.message || csReadErr) + " (不影响生成,但无法确认色彩空间)", "error");
                }
            }

            // 使用 imaging API 直接读取文档合成视图像素（零闪烁）
            // componentSize: 8 强制输出8bit，即使文档是16/32bit
            var pixelData;
            try {
                var _gpOpts = {
                    documentID: doc.id,
                    sourceBounds: { left: selBounds.left, top: selBounds.top, right: selBounds.right, bottom: selBounds.bottom },
                    targetSize: { width: tw, height: th },
                    componentSize: 8,
                    colorSpace: "RGB",
                    applyAlpha: false
                };
                if (csOn) {
                    _gpOpts.colorProfile = "sRGB IEC61966-2.1";
                    logToPanel("[色彩稳定] 抓图请求 PS 将像素转为 sRGB IEC61966-2.1...", "info");
                }
                pixelData = await imaging.getPixels(_gpOpts);
                if (csOn) logToPanel("[色彩稳定] ✓ 抓图已按 sRGB 输出", "success");
            } catch(gpErr) {
                // 某些PS版本在16/32bit文档上 componentSize:8 会报错
                // 降级：不指定 componentSize，读取原始位深数据后手动转换
                if (csOn) logToPanel("[色彩稳定] ⚠ 带 sRGB 的抓图失败,进入降级路径: " + (gpErr.message || gpErr), "warn");
                if (is16bit || is32bit) {
                    console.log("[imaging] componentSize:8 失败 (" + gpErr.message + ")，降级读取原始位深数据...");
                    logToPanel("[兼容] componentSize:8 不支持此文档，使用降级读取方式", "warn");
                    var _gpOpts2 = {
                        documentID: doc.id,
                        sourceBounds: { left: selBounds.left, top: selBounds.top, right: selBounds.right, bottom: selBounds.bottom },
                        targetSize: { width: tw, height: th },
                        colorSpace: "RGB",
                        applyAlpha: false
                    };
                    if (csOn) _gpOpts2.colorProfile = "sRGB IEC61966-2.1";
                    pixelData = await imaging.getPixels(_gpOpts2);
                } else {
                    throw gpErr;
                }
            }
            // 兼容不同UXP版本的返回格式
            var imgObj = pixelData.imageData || pixelData;
            var comp = imgObj.components || 3;
            var pw = imgObj.width, ph = imgObj.height;
            // 检测实际返回的 componentSize
            var actualComponentSize = imgObj.componentSize || 8;
            console.log("[imaging] 像素数据: " + pw + "x" + ph + " comp=" + comp + " componentSize=" + actualComponentSize + " docBitDepth=" + docBitDepth);

            // 获取像素buffer（兼容getData方法和直接data属性）
            var rawBuf;
            if (typeof imgObj.getData === 'function') {
                rawBuf = await imgObj.getData({});
            } else {
                rawBuf = imgObj.data;
            }

            // 统一转换为 Uint8Array（处理各种返回类型）
            var pixels;
            var rawIsUint16 = (rawBuf instanceof Uint16Array);
            var rawIsFloat32 = (rawBuf instanceof Float32Array);
            if (rawBuf instanceof Uint8Array) {
                pixels = rawBuf;
            } else if (rawIsUint16) {
                // Uint16Array: 从16bit值转换为8bit
                // 注意: Photoshop 16-bit模式值域为 0-32768（不是标准的 0-65535）
                console.log("[imaging] 返回类型: Uint16Array, 长度=" + rawBuf.length);
                var expectedPixelCount = pw * ph * comp;
                // 采样检测实际值域：PS用0-32768，标准用0-65535
                var maxSampleVal = 0;
                var sampleLimit = Math.min(rawBuf.length, 5000);
                for (var smi = 0; smi < sampleLimit; smi++) {
                    if (rawBuf[smi] > maxSampleVal) maxSampleVal = rawBuf[smi];
                }
                var isPS32768Range = (maxSampleVal > 0 && maxSampleVal <= 32769);
                console.log("[imaging] 16bit值域检测: maxSample=" + maxSampleVal + " isPS32768=" + isPS32768Range);
                var pixels8from16 = new Uint8Array(expectedPixelCount);
                if (isPS32768Range) {
                    // PS范围 0-32768 → 0-255
                    for (var u16i = 0; u16i < expectedPixelCount && u16i < rawBuf.length; u16i++) {
                        pixels8from16[u16i] = Math.min(255, Math.round(rawBuf[u16i] * 255 / 32768));
                    }
                    logToPanel("[兼容] 16-bit (PS 0-32768) → 8-bit 转换完成", "success");
                } else {
                    // 标准范围 0-65535 → 0-255
                    for (var u16i2 = 0; u16i2 < expectedPixelCount && u16i2 < rawBuf.length; u16i2++) {
                        pixels8from16[u16i2] = Math.min(255, (rawBuf[u16i2] + 128) >> 8);
                    }
                    logToPanel("[兼容] 16-bit (标准 0-65535) → 8-bit 转换完成", "success");
                }
                pixels = pixels8from16;
                if (csOn) logToPanel("[色彩稳定] ⚠ 16-bit 值域靠采样推断(" + (isPS32768Range ? "PS 0-32768" : "标准 0-65535") + "),极暗图可能误判致偏亮,结果以实拍为准", "warn");
            } else if (rawIsFloat32) {
                // Float32Array: 32-bit浮点（0.0-1.0）转换为8bit
                console.log("[imaging] 返回类型: Float32Array, 长度=" + rawBuf.length);
                var expectedPixelCount32 = pw * ph * comp;
                var pixels8from32 = new Uint8Array(expectedPixelCount32);
                if (csOn) {
                    // 色彩稳定:32-bit 文档为线性光,直接*255会整体偏暗;此处补 sRGB gamma 编码(OETF)
                    for (var f32i = 0; f32i < expectedPixelCount32 && f32i < rawBuf.length; f32i++) {
                        var lv = rawBuf[f32i];
                        if (lv < 0) lv = 0; if (lv > 1) lv = 1;
                        var sv = (lv <= 0.0031308) ? (lv * 12.92) : (1.055 * Math.pow(lv, 1 / 2.4) - 0.055);
                        pixels8from32[f32i] = Math.max(0, Math.min(255, Math.round(sv * 255)));
                    }
                    logToPanel("[色彩稳定] 32-bit 线性光 → sRGB gamma → 8-bit (已修正偏暗)", "success");
                } else {
                    for (var f32i = 0; f32i < expectedPixelCount32 && f32i < rawBuf.length; f32i++) {
                        var fval = rawBuf[f32i];
                        if (fval < 0) fval = 0;
                        if (fval > 1) fval = 1;
                        pixels8from32[f32i] = Math.round(fval * 255);
                    }
                    logToPanel("[兼容] 32-bit Float32 → 8-bit 转换完成", "success");
                }
                pixels = pixels8from32;
            } else if (rawBuf instanceof ArrayBuffer) {
                pixels = new Uint8Array(rawBuf);
            } else if (rawBuf && rawBuf.buffer) {
                pixels = new Uint8Array(rawBuf.buffer);
            } else {
                pixels = new Uint8Array(rawBuf);
            }

            // 二次检测：即使传了 Uint8Array，长度可能是16bit的（某些PS版本忽略componentSize:8）
            var expectedLen8 = pw * ph * comp;
            var expectedLen16 = pw * ph * comp * 2;
            if (!rawIsUint16 && !rawIsFloat32 && pixels.length === expectedLen16 && pixels.length !== expectedLen8) {
                console.log("[imaging] 检测到16bit字节数据（长度=" + pixels.length + "，期望8bit长度=" + expectedLen8 + "），正在转换...");
                var pixels8conv = new Uint8Array(expectedLen8);
                // 检测字节序：采样前几个像素，判断大端还是小端
                // 大端(BE): [high, low] → high字节更有意义
                // 小端(LE): [low, high] → high在第二个字节
                var sumEven = 0, sumOdd = 0;
                var sampleCount = Math.min(100, expectedLen8);
                for (var si = 0; si < sampleCount; si++) {
                    sumEven += pixels[si * 2];       // 偶数位
                    sumOdd += pixels[si * 2 + 1];    // 奇数位
                }
                // 如果偶数位的平均值明显更大 → 大端；否则 → 小端
                var isBigEndian = (sumEven >= sumOdd);
                var highByteOffset = isBigEndian ? 0 : 1;
                console.log("[imaging] 字节序检测: " + (isBigEndian ? "Big-Endian" : "Little-Endian") + " (even=" + sumEven + " odd=" + sumOdd + ")");
                // 组合两个字节为完整16bit值，再判断PS范围(0-32768)还是标准范围(0-65535)
                var maxVal16b = 0;
                var checkLimit = Math.min(5000, expectedLen8);
                for (var ci = 0; ci < checkLimit; ci++) {
                    var hb = pixels[ci * 2 + (isBigEndian ? 0 : 1)];
                    var lb = pixels[ci * 2 + (isBigEndian ? 1 : 0)];
                    var v16 = (hb << 8) | lb;
                    if (v16 > maxVal16b) maxVal16b = v16;
                }
                var isPS16bRange = (maxVal16b > 0 && maxVal16b <= 32769);
                console.log("[imaging] 字节16bit值域: maxVal=" + maxVal16b + " isPS32768=" + isPS16bRange);
                for (var bi = 0; bi < expectedLen8; bi++) {
                    var hiB = pixels[bi * 2 + (isBigEndian ? 0 : 1)];
                    var loB = pixels[bi * 2 + (isBigEndian ? 1 : 0)];
                    var val16b = (hiB << 8) | loB;
                    if (isPS16bRange) {
                        pixels8conv[bi] = Math.min(255, Math.round(val16b * 255 / 32768));
                    } else {
                        pixels8conv[bi] = Math.min(255, (val16b + 128) >> 8);
                    }
                }
                pixels = pixels8conv;
                logToPanel("[兼容] 16-bit 字节数据 → 8-bit 转换完成 (" + (isBigEndian ? "BE" : "LE") + ", " + (isPS16bRange ? "PS 0-32768" : "标准 0-65535") + ")", "success");
                if (csOn) logToPanel("[色彩稳定] ⚠ 16-bit 字节值域靠采样推断,极暗图可能误判致偏亮,结果以实拍为准", "warn");
            }

            // 最终长度校验
            if (pixels.length !== expectedLen8) {
                console.warn("[imaging] 像素长度不匹配! 实际=" + pixels.length + " 期望=" + expectedLen8 + " (可能是32bit或其他格式)");
                // 尝试截取或填充
                if (pixels.length > expectedLen8) {
                    pixels = pixels.subarray(0, expectedLen8);
                    logToPanel("[兼容] 像素数据已截取到正确长度", "warn");
                } else {
                    var padded = new Uint8Array(expectedLen8);
                    padded.set(pixels);
                    pixels = padded;
                    logToPanel("[兼容] 像素数据已填充到正确长度", "warn");
                }
            }

            console.log("[imaging] pixels长度=" + pixels.length + " 期望=" + expectedLen8 + " 首像素=[" + pixels[0] + "," + pixels[1] + "," + pixels[2] + "]");
            // 抗截断处理（纯内存操作）
            if (state.getAntiTruncationMode() > 0) {
                pixelsHueShift180(pixels, pw * ph, comp);
                if (state.getAntiTruncationMode() === 2) {
                    pixelsFlipVertical(pixels, pw, ph, comp);
                }
            }
            // 编码图像（抓图导出固定 PNG）
            var resultBase64;
            var formatLabel;
            var pngBytes = encodePNGFromRGB(pw, ph, pixels, comp, csOn);
            resultBase64 = arrayBufferToBase64(pngBytes.buffer);
            formatLabel = 'PNG';
            if (csOn) logToPanel("[色彩稳定] ✓ 传出 PNG 已写入 sRGB 标记", "success");
            var rawSizeKB = (pixels.length / 1024).toFixed(1);
            var b64SizeKB = (resultBase64.length / 1024).toFixed(1);
            logToPanel("[图像] " + pw + "x" + ph + " | 格式:" + formatLabel + " | 原始RGB:" + rawSizeKB + "KB → 实际传输:" + b64SizeKB + "KB", "info");
            result = { base64: resultBase64, selection: selBounds };
            // 释放imaging资源
            try { if (imgObj.dispose) imgObj.dispose(); } catch(e) {}
            try { if (pixelData.imageData && pixelData.imageData.dispose) pixelData.imageData.dispose(); } catch(e) {}
        }, { commandName: "抓取选区图片" });
    } catch (e) {
        if (e && e.message && e.message.startsWith("NO_SELECTION")) {
            var parts = e.message.split("|");
            if (parts.length > 1) {
                logToPanel("[选区] " + parts[1], "error");
            }
            return null;
        }
        if (e && e.message && e.message.includes("选区")) throw e;

        // 兜底: 异常对象可能没有 .message (executeAsModal/imaging API 抛的某些 PSError 是这样)
        var errStr;
        if (!e) {
            errStr = "(异常对象为空)";
        } else if (e instanceof Error) {
            errStr = e.message || e.name || e.code || "(Error 对象但无 message/name/code)";
        } else if (typeof e === 'string') {
            errStr = e;
        } else if (typeof e === 'object') {
            // PSError 等自定义对象: 把所有可读字段拼出来
            var fields = [];
            try { if (e.message != null) fields.push("message=" + e.message); } catch(_) {}
            try { if (e.name != null) fields.push("name=" + e.name); } catch(_) {}
            try { if (e.code != null) fields.push("code=" + e.code); } catch(_) {}
            try { if (e.number != null) fields.push("number=" + e.number); } catch(_) {}
            try { if (e.description != null) fields.push("description=" + e.description); } catch(_) {}
            if (fields.length === 0) {
                try { errStr = JSON.stringify(e); } catch(_) { errStr = "(无法序列化的异常对象)"; }
            } else {
                errStr = fields.join(" | ");
            }
        } else {
            errStr = String(e);
        }

        console.error("[getSelectionAndImage] 错误:", errStr, e);
        logToPanel("[错误] 选区抓取异常: " + errStr, "error");

        // 诊断: 重新从 app.activeDocument 拿 (catch 块外层 doc 变量不可见)
        try {
            var _docNow = app.activeDocument;
            if (_docNow) {
                var _diag = [];
                try { _diag.push("位深:" + (_docNow.bitsPerChannel || "?") + "bit"); } catch(x) {}
                try { _diag.push("模式:" + (_docNow.mode || "?")); } catch(x) {}
                try { _diag.push("尺寸:" + _docNow.width + "x" + _docNow.height); } catch(x) {}
                try { _diag.push("文档名:" + _docNow.name); } catch(x) {}
                if (_diag.length > 0) logToPanel("[诊断] " + _diag.join(" | "), "warn");
            } else {
                logToPanel("[诊断] 当前没有活动文档 (app.activeDocument 为空)", "warn");
            }
        } catch(diagErr) {}

        // 只有明确的 NO_SELECTION 才返回 null；其它抓图异常交给 cv-host 回传真实原因。
        var captureErr = new Error("选区抓取失败: " + errStr);
        captureErr.code = "SELECTION_CAPTURE_FAILED";
        throw captureErr;
    }
    return result;
}

// ===== placeImageToSpecificDoc 来自 host/ps-io.js (第 531-697 行, 原文) =====
async function placeImageToSpecificDoc(base64Str, targetDocId, targetSelection, antiMode, layerType) {
    var tempFolder = await fs.getTemporaryFolder();
    var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    var rawFile = await tempFolder.createFile("temp_raw_" + ts + ".png", { overwrite: true });
    // 色彩稳定:给 AI 回传的 PNG 注入 sRGB 标记,PS 置入时会自动从 sRGB 转换到文档工作空间(避免回传偏色)
    var _rawBytes = base64ToArrayBuffer(base64Str);
    var _csOnPlace = false;
    try { _csOnPlace = !!state.getColorStable(); } catch(eCSP) { _csOnPlace = false; }
    if (_csOnPlace) {
        try {
            var _u8 = new Uint8Array(_rawBytes);
            if (_u8.length > 8 && _u8[0] === 137 && _u8[1] === 80 && _u8[2] === 78 && _u8[3] === 71) {
                var _tagged = injectSRGBChunkIntoPNG(_u8);
                _rawBytes = _tagged.buffer.slice(_tagged.byteOffset, _tagged.byteOffset + _tagged.byteLength);
                logToPanel("[色彩稳定] ✓ 回传图已标记 sRGB,PS 将自动转换到文档色彩空间", "info");
            } else {
                logToPanel("[色彩稳定] ⚠ 回传图非 PNG(疑为 JPEG),本版不注入色彩标记;若文档非 sRGB 回传端可能仍偏色,建议传出格式用 PNG", "warn");
            }
        } catch(_csPlaceErr) {
            logToPanel("[色彩稳定] ✗ 回传图 sRGB 标记注入失败: " + (_csPlaceErr.message || _csPlaceErr) + " (改用原始字节置入)", "error");
            _rawBytes = base64ToArrayBuffer(base64Str);
        }
    }
    await rawFile.write(_rawBytes, { format: storage.formats.binary });
    var createdLayerId = null;
    try {
    await core.executeAsModal(async function() {
        var targetDoc = app.documents.find(function(d) { return d.id === targetDocId; });
        if (!targetDoc) throw new Error("找不到目标文档");

        // === Step 1: 切到目标文档 ===
        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: targetDocId }] }], {});
        // 确保选中最顶层图层（退出任何编组上下文）
        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _enum: "ordinal", _value: "front" }], makeVisible: false }], {});

        // === Step 2: 用 placeEvent 直接置入原始文件（无需打开临时文档） ===
        var placeToken = await fs.createSessionToken(rawFile);
        await app.batchPlay([{
            _obj: "placeEvent",
            null: { _path: placeToken, _kind: "local" },
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
        }], {});
        // placeEvent 自动选中新建的智能对象图层

        // === Step 3: 精确定位到选区位置（分步操作避免偏移） ===
        if (targetSelection) {
            // 获取置入图层的当前 bounds（使用 boundsNoEffects 避免图层效果干扰）
            var boundsResult = await app.batchPlay([{
                _obj: "get",
                _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], {});
            var curLeft = 0, curTop = 0, curWidth = 0, curHeight = 0;
            if (boundsResult && boundsResult[0] && boundsResult[0].boundsNoEffects) {
                var b = boundsResult[0].boundsNoEffects;
                curLeft = (b.left && b.left._value !== undefined) ? b.left._value : (b.left || 0);
                curTop = (b.top && b.top._value !== undefined) ? b.top._value : (b.top || 0);
                var bRight = (b.right && b.right._value !== undefined) ? b.right._value : (b.right || 0);
                var bBottom = (b.bottom && b.bottom._value !== undefined) ? b.bottom._value : (b.bottom || 0);
                curWidth = bRight - curLeft;
                curHeight = bBottom - curTop;
            }
            // 降级：如果 boundsNoEffects 失败，用普通 bounds
            if (curWidth <= 0 || curHeight <= 0) {
                var boundsResult2 = await app.batchPlay([{
                    _obj: "get",
                    _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                }], {});
                if (boundsResult2 && boundsResult2[0] && boundsResult2[0].bounds) {
                    var b2 = boundsResult2[0].bounds;
                    curLeft = (b2.left && b2.left._value !== undefined) ? b2.left._value : (b2.left || 0);
                    curTop = (b2.top && b2.top._value !== undefined) ? b2.top._value : (b2.top || 0);
                    var b2Right = (b2.right && b2.right._value !== undefined) ? b2.right._value : (b2.right || 0);
                    var b2Bottom = (b2.bottom && b2.bottom._value !== undefined) ? b2.bottom._value : (b2.bottom || 0);
                    curWidth = b2Right - curLeft;
                    curHeight = b2Bottom - curTop;
                }
            }
            console.log("[贴图] 当前图层bounds: left=" + curLeft + " top=" + curTop + " w=" + curWidth + " h=" + curHeight);
            console.log("[贴图] 目标选区: left=" + targetSelection.left + " top=" + targetSelection.top + " w=" + targetSelection.width + " h=" + targetSelection.height);

            // Step 3a: 先缩放到目标尺寸（从左上角缩放）
            if (curWidth > 0 && curHeight > 0) {
                var scaleX = (targetSelection.width / curWidth) * 100;
                var scaleY = (targetSelection.height / curHeight) * 100;
                if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
                    await app.batchPlay([{
                        _obj: "transform",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
                        width: { _unit: "percentUnit", _value: scaleX },
                        height: { _unit: "percentUnit", _value: scaleY },
                        interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
                    }], {});
                }
            }

            // Step 3b: 再精确移动到目标位置（读取缩放后的实际bounds）
            var newBoundsResult = await app.batchPlay([{
                _obj: "get",
                _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], {});
            var newLeft = curLeft, newTop = curTop;
            if (newBoundsResult && newBoundsResult[0] && newBoundsResult[0].bounds) {
                var nb = newBoundsResult[0].bounds;
                newLeft = (nb.left && nb.left._value !== undefined) ? nb.left._value : (nb.left || 0);
                newTop = (nb.top && nb.top._value !== undefined) ? nb.top._value : (nb.top || 0);
            }
            var moveX = targetSelection.left - newLeft;
            var moveY = targetSelection.top - newTop;
            console.log("[贴图] 移动偏移: dx=" + moveX + " dy=" + moveY);
            if (Math.abs(moveX) > 0.5 || Math.abs(moveY) > 0.5) {
                await app.batchPlay([{
                    _obj: "move",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    to: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: Math.round(moveX) }, vertical: { _unit: "pixelsUnit", _value: Math.round(moveY) } }
                }], {});
            }
        }

        // === Step 4+5: 按图层类型分流（关键修复：智能对象不再栅格化，保住内部原生 2048）===
        if (layerType === 'smartObject') {
            // 【智能对象输出】placeEvent 进来本就是装着完整原生 2048 的智能对象。
            // 绝不栅格化、绝不 newPlacedLayer —— 否则会把已被缩放显示到选区尺寸的内容烤死成低分辨率像素。
            // 抗截断反转直接作用在智能对象上：flip 是非破坏变换；hueSaturation 会自动变成智能滤镜，
            // 都不会破坏内部的 2048 像素（代价：智能对象“内部源”仍是反色，仅显示被滤镜纠正，正常使用无感）。
            if (antiMode > 0) {
                if (antiMode === 2) {
                    // 垂直翻转图层（非破坏变换，智能对象内部数据不丢）
                    await app.batchPlay([{
                        _obj: "flip",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        axis: { _enum: "orientation", _value: "vertical" }
                    }], {});
                }
                // 色相反转180度（作用在智能对象上 → 智能滤镜，非破坏）
                await app.batchPlay([{
                    _obj: "hueSaturation",
                    adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 180, saturation: 0, lightness: 0 }],
                    colorize: false
                }], {});
            }
            // —— 结束：图层保持为原生 2048 智能对象，显示缩放到选区尺寸 ——
        } else {
            // 【栅格化输出】维持老链路：先栅格化成像素，再在像素上做抗截断反转。
            await app.batchPlay([{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
            if (antiMode > 0) {
                if (antiMode === 2) {
                    // 翻转图层（非文档）：选中图层后执行垂直翻转
                    await app.batchPlay([{
                        _obj: "flip",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        axis: { _enum: "orientation", _value: "vertical" }
                    }], {});
                }
                // 色相反转180度
                await app.batchPlay([{
                    _obj: "hueSaturation",
                    adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 180, saturation: 0, lightness: 0 }],
                    colorize: false
                }], {});
            }
        }

        createdLayerId = app.activeDocument.activeLayers[0].id;
    }, { commandName: "贴回图片" });
    return createdLayerId;
    } finally {
        try { await rawFile.delete(); } catch (_) {}
    }
}

window.CV_PSIO = {
    getSelectionAndImage: getSelectionAndImage,
    placeImageToSpecificDoc: placeImageToSpecificDoc
};

})();
