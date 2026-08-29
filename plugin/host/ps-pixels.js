// ============================================================
//  ps-pixels.js
//  像素处理 & 图像编码工具（纯函数，无外部依赖）
//
//  - Base64 / ArrayBuffer 互转
//  - 色相偏移 180°、垂直翻转
//  - PNG 编码（store 模式）
//  - JPEG 编码（Baseline，不依赖 Canvas）
//
//  从 index.js 抽出，行为完全一致。
// ============================================================

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

module.exports = {
    arrayBufferToBase64: arrayBufferToBase64,
    base64ToArrayBuffer: base64ToArrayBuffer,
    pixelsHueShift180: pixelsHueShift180,
    pixelsFlipVertical: pixelsFlipVertical,
    encodeJPEGFromRGB: encodeJPEGFromRGB,
    encodePNGFromRGB: encodePNGFromRGB,
    injectSRGBChunkIntoPNG: injectSRGBChunkIntoPNG
};
