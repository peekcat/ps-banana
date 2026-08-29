(function() {
'use strict';

// ============================================================
//  tile-camera.js - 3D 镜头控制(WebGL)
//  从旧版 tab-advanced.js 原样迁移,适配磁贴架构
// ============================================================

// 磁贴大小达到阈值才渲染 3D canvas;否则只显示入口提示
// 就地展开 / 大卡片 / 全屏态下才有 3D
function _shouldRender3D(sizeHint) {
  var layout = sizeHint && sizeHint.layout;
  return layout === 'wide' || layout === 'wideshort' || layout === 'square';
}

TileAPI.registerTile({
  id: 'camera',
  group: 'main',
  icon: '\uD83C\uDFAC',
  label: '3D 镜头',
  desc: '镜头角度 + AI 重构',
  live: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w, h) {
    if (w >= 2) {
      container.innerHTML =
        '<div class="tile-icon">\uD83C\uDFAC</div>' +
        '<div class="tile-label">3D 镜头</div>' +
        '<div class="tile-desc">角度重构</div>';
    } else {
      container.innerHTML =
        '<div class="tile-icon">\uD83C\uDFAC</div>' +
        '<div class="tile-label">镜头</div>';
    }
  },

  renderBack: function(container) {
    container.textContent = '3D 镜头控制';
  },

  onExpand: function(container, sizeHint) {
    if (!_shouldRender3D(sizeHint)) {
      container.innerHTML =
        '<div class="w10-panel">' +
          '<div class="panel-placeholder" style="min-height:180px;flex-direction:column;gap:10px;">' +
            '<div class="panel-placeholder-icon">\uD83C\uDFAC</div>' +
            '<div class="panel-placeholder-text">3D 镜头控制</div>' +
            '<div style="font-size:10px;color:var(--text-sub);text-align:center;line-height:1.6;max-width:200px;">请将磁贴放大至 2×2 以上或就地展开查看完整 3D 控制面板</div>' +
          '</div>' +
        '</div>';
      return;
    }
    return _renderCam3D(container);
  }
});

function _renderCam3D(container) {
  container.innerHTML =
    '<div class="w10-panel cam3d-panel">' +
      '<div class="cam3d-canvas-wrap">' +
        '<canvas id="camCanvas" class="cam3d-canvas" width="400" height="300"></canvas>' +
        '<input type="range" id="camZoomSlider" class="cam3d-zoom-slider" min="0.5" max="2.0" step="0.05" value="1.0" title="缩放"/>' +
        '<div id="btnCamCapture" class="cam3d-capture-btn" title="从 PS 选区截取图像">\uD83D\uDCF7 加载图像</div>' +
      '</div>' +
      '<div class="cam3d-controls">' +
        '<div class="cam3d-row">' +
          '<span class="cam3d-dot cam3d-dot-az"></span>' +
          '<label class="cam3d-label">方位</label>' +
          '<input type="range" id="camAzimuth" class="cam3d-slider cam3d-slider-az" min="0" max="315" step="1" value="0"/>' +
          '<span id="camAzVal" class="cam3d-val cam3d-val-az">0\u00b0</span>' +
          '<span id="camAzReset" class="cam3d-reset" title="重置">\u21ba</span>' +
        '</div>' +
        '<div class="cam3d-row">' +
          '<span class="cam3d-dot cam3d-dot-el"></span>' +
          '<label class="cam3d-label">仰角</label>' +
          '<input type="range" id="camElevation" class="cam3d-slider cam3d-slider-el" min="-90" max="90" step="1" value="0"/>' +
          '<span id="camElVal" class="cam3d-val cam3d-val-el">0\u00b0</span>' +
          '<span id="camElReset" class="cam3d-reset" title="重置">\u21ba</span>' +
        '</div>' +
        '<div class="cam3d-row">' +
          '<span class="cam3d-dot cam3d-dot-ds"></span>' +
          '<label class="cam3d-label">距离</label>' +
          '<input type="range" id="camDistance" class="cam3d-slider cam3d-slider-ds" min="0.6" max="4.0" step="0.1" value="1.0"/>' +
          '<span id="camDsVal" class="cam3d-val cam3d-val-ds">1.0</span>' +
          '<span id="camDsReset" class="cam3d-reset" title="重置">\u21ba</span>' +
        '</div>' +
      '</div>' +
      '<div id="camPromptPreview" class="cam3d-preview">&lt;sks&gt; front view eye-level shot medium close-up shot</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">API 引擎</div></div>' +
        '<div class="w10-row-right">' +
          TileAPI.slotOrder().map(function(eng) {
            var def = eng === 'aji' ? 'AJI' : eng === 'grs' ? TileAPI.computeBrand() : '其他';
            var id = 'camProv' + eng.charAt(0).toUpperCase() + eng.slice(1);
            return '<button class="w10-btn" id="' + id + '" data-prov="' + eng + '">' + TileAPI.slotLabel(eng, def) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">模型</div></div>' +
        '<div class="w10-row-right"><select class="w10-select" id="camModelInput"></select></div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">分辨率</div></div>' +
        '<div class="w10-row-right">' +
          '<select class="w10-select" id="camSizeInput">' +
            '<option value="1K">1K</option>' +
            '<option value="2K" selected>2K</option>' +
            '<option value="4K">4K</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">宽高比</div></div>' +
        '<div class="w10-row-right">' +
          '<select class="w10-select" id="camAspectRatioInput">' +
            '<option value="1:1" selected>1:1</option>' +
            '<option value="Auto">Auto</option>' +
            '<option value="9:16">9:16</option>' +
            '<option value="16:9">16:9</option>' +
            '<option value="2:3">2:3</option>' +
            '<option value="3:2">3:2</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left"><div class="w10-row-label">数量</div></div>' +
        '<div class="w10-row-right"><input type="number" class="w10-input" id="camBatchInput" value="1" min="1" max="5" style="max-width:60px"/></div>' +
      '</div>' +
      '<input type="hidden" id="camTimeoutInput" value="3600"/>' +
      '<button class="w10-btn w10-btn-accent cam3d-btn-go" id="btnCamGenerate">\uD83D\uDE80 开始生成</button>' +
    '</div>';

  return _initCameraWebGL(container);
}

// ============================================================
//  WebGL 初始化 —— 原样迁移自旧版 tab-advanced.js
// ============================================================
function _initCameraWebGL(container) {
  function $id(id) { return container.querySelector('#' + id); }

  var canvas = $id('camCanvas');
  if (!canvas) return;
  var gl = canvas.getContext('webgl', { alpha:false, antialias:true, preserveDrawingBuffer:false })
        || canvas.getContext('experimental-webgl', { alpha:false, antialias:true });
  if (!gl) { console.error('[镜头] WebGL 不支持'); return; }

  var slAz = $id('camAzimuth'), slEl = $id('camElevation'), slDs = $id('camDistance');
  var lbAz = $id('camAzVal'),   lbEl = $id('camElVal'),     lbDs = $id('camDsVal');
  var preview = $id('camPromptPreview');
  var _camImage = null, _camImageB64 = null;

  var AZ_MAP = [[0,'front view'],[45,'three-quarter front-right view'],[90,'right-side view'],[135,'three-quarter back-right view'],[180,'back view'],[225,'three-quarter back-left view'],[270,'left-side view'],[315,'three-quarter front-left view']];
  var AZ_CN = {0:'正面视角',45:'右前3/4',90:'右侧面',135:'右后3/4',180:'背面视角',225:'左后3/4',270:'左侧面',315:'左前3/4'};
  var EL_MAP = [[-90,"worm's-eye view"],[-60,'extreme low-angle shot'],[-30,'low-angle shot'],[0,'eye-level shot'],[30,'slightly high-angle shot'],[60,'high-angle shot'],[90,'top-down view']];
  var EL_CN = {'-90':'仰拍','-60':'强仰视','-30':'微仰视','0':'平视','30':'微俯视','60':'高俯视','90':'鸟瞰'};
  var DS_MAP = [[0.6,'extreme close-up'],[0.8,'close-up'],[1.0,'medium close-up'],[1.4,'medium shot'],[2.0,'full shot'],[3.0,'wide shot'],[4.0,'extreme wide shot']];
  var DS_CN = {'0.6':'超特写','0.8':'特写','1':'中近景','1.4':'中景','2':'全身','3':'远景','4':'大远景'};
  var PRESERVE_SUFFIX = '. Strictly preserve the subject\'s pose, gesture, facial expression and body posture. Keep the background, environment, lighting, color grading and shadows completely unchanged. Only reconstruct the camera angle of the main subject, do not alter any other element in the scene.';

  function nearest(map, val) { var best=map[0],bd=Math.abs(val-map[0][0]); for(var i=1;i<map.length;i++){var d=Math.abs(val-map[i][0]);if(d<bd){bd=d;best=map[i];}} return best[1]; }
  function nearestKey(map, val) { var bk=Object.keys(map)[0],bd=Math.abs(val-Number(bk)); for(var k in map){var d=Math.abs(val-Number(k));if(d<bd){bd=d;bk=k;}} return map[bk]; }
  function getValues() { return { az:Number(slAz.value), el:Number(slEl.value), ds:Number(slDs.value) }; }
  function buildPrompt() { var v=getValues(); return '<sks> '+nearest(AZ_MAP,v.az)+' '+nearest(EL_MAP,v.el)+' '+nearest(DS_MAP,v.ds)+' shot'+PRESERVE_SUFFIX; }
  function updateLabels() { var v=getValues(); lbAz.innerText=v.az+'\u00b0'; lbEl.innerText=v.el+'\u00b0'; lbDs.innerText=v.ds.toFixed(1); preview.innerText=buildPrompt(); drawCanvas(); }

  var COL_AZ = [0.33,0.76,1.0], COL_EL = [0.73,0.45,1.0], COL_DS = [1.0,0.58,0.22];

  function m4c() { return new Float32Array(16); }
  function m4c_persp(o, fovY, ar, n, f) { for(var i=0;i<16;i++) o[i]=0; var ff=1/Math.tan(fovY/2); o[0]=ff/ar; o[5]=ff; o[10]=(f+n)/(n-f); o[11]=-1; o[14]=(2*f*n)/(n-f); return o; }
  function m4c_lookAt(o, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
    var fx=cx-ex,fy=cy-ey,fz=cz-ez; var fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1; fx/=fl;fy/=fl;fz/=fl;
    var sx=fy*uz-fz*uy,sy=fz*ux-fx*uz,sz=fx*uy-fy*ux; var sl=Math.sqrt(sx*sx+sy*sy+sz*sz)||1; sx/=sl;sy/=sl;sz/=sl;
    var ux2=sy*fz-sz*fy,uy2=sz*fx-sx*fz,uz2=sx*fy-sy*fx;
    o[0]=sx;o[1]=ux2;o[2]=-fx;o[3]=0; o[4]=sy;o[5]=uy2;o[6]=-fy;o[7]=0; o[8]=sz;o[9]=uz2;o[10]=-fz;o[11]=0;
    o[12]=-(sx*ex+sy*ey+sz*ez); o[13]=-(ux2*ex+uy2*ey+uz2*ez); o[14]=(fx*ex+fy*ey+fz*ez); o[15]=1; return o;
  }
  function m4c_mul(o, a, b) { var t=m4c(); for(var i=0;i<4;i++) for(var j=0;j<4;j++) t[j*4+i]=a[i]*b[j*4]+a[4+i]*b[j*4+1]+a[8+i]*b[j*4+2]+a[12+i]*b[j*4+3]; for(var k=0;k<16;k++) o[k]=t[k]; return o; }

  var LINE_VS='attribute vec3 aPos;attribute vec4 aCol;uniform mat4 uMVP;varying vec4 vCol;void main(){gl_Position=uMVP*vec4(aPos,1.0);vCol=aCol;}';
  var LINE_FS='precision mediump float;varying vec4 vCol;void main(){gl_FragColor=vCol;}';
  var POINT_VS='attribute vec3 aPos;attribute vec4 aCol;attribute float aSize;uniform mat4 uMVP;varying vec4 vCol;void main(){gl_Position=uMVP*vec4(aPos,1.0);gl_PointSize=aSize;vCol=aCol;}';
  var POINT_FS='precision mediump float;varying vec4 vCol;void main(){float d=distance(gl_PointCoord,vec2(0.5));if(d>0.5)discard;float glow=smoothstep(0.5,0.15,d);gl_FragColor=vec4(vCol.rgb,vCol.a*glow);}';
  var TEX_VS='attribute vec3 aPos;attribute vec2 aUV;uniform mat4 uMVP;varying vec2 vUV;void main(){gl_Position=uMVP*vec4(aPos,1.0);vUV=aUV;}';
  var TEX_FS='precision mediump float;varying vec2 vUV;uniform sampler2D uTex;uniform float uAlpha;void main(){vec4 c=texture2D(uTex,vUV);gl_FragColor=vec4(c.rgb,c.a*uAlpha);}';

  function _cs(src,type){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){console.error('[镜头GL]',gl.getShaderInfoLog(s));return null;}return s;}
  function _cp(vs,fs,attr){var v=_cs(vs,gl.VERTEX_SHADER),f=_cs(fs,gl.FRAGMENT_SHADER);if(!v||!f)return null;var p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);if(attr)attr.forEach(function(a,i){gl.bindAttribLocation(p,i,a);});gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){console.error('[镜头GL]',gl.getProgramInfoLog(p));return null;}return p;}

  var pLine,pPoint,pTex, uMVP_l,uMVP_p,uMVP_t,uTex_t,uAlpha_t;
  var bLine,bPoint,bTex,bTexIdx;

  function initShaders() {
    pLine=_cp(LINE_VS,LINE_FS,['aPos','aCol']); uMVP_l=gl.getUniformLocation(pLine,'uMVP');
    pPoint=_cp(POINT_VS,POINT_FS,['aPos','aCol','aSize']); uMVP_p=gl.getUniformLocation(pPoint,'uMVP');
    pTex=_cp(TEX_VS,TEX_FS,['aPos','aUV']); uMVP_t=gl.getUniformLocation(pTex,'uMVP'); uTex_t=gl.getUniformLocation(pTex,'uTex'); uAlpha_t=gl.getUniformLocation(pTex,'uAlpha');
  }
  function initBuffers() {
    bLine=gl.createBuffer(); bPoint=gl.createBuffer(); bTex=gl.createBuffer();
    bTexIdx=gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bTexIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,0,2,3]),gl.STATIC_DRAW);
  }

  function drawLines(verts,mode){if(!verts.length)return;gl.useProgram(pLine);gl.uniformMatrix4fv(uMVP_l,false,mvp);gl.bindBuffer(gl.ARRAY_BUFFER,bLine);gl.bufferData(gl.ARRAY_BUFFER,verts,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(0,3,gl.FLOAT,false,28,0);gl.vertexAttribPointer(1,4,gl.FLOAT,false,28,12);gl.drawArrays(mode||gl.LINES,0,verts.length/7);gl.disableVertexAttribArray(0);gl.disableVertexAttribArray(1);}
  function drawPoints(verts){if(!verts.length)return;gl.useProgram(pPoint);gl.uniformMatrix4fv(uMVP_p,false,mvp);gl.bindBuffer(gl.ARRAY_BUFFER,bPoint);gl.bufferData(gl.ARRAY_BUFFER,verts,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1);gl.enableVertexAttribArray(2);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);gl.vertexAttribPointer(1,4,gl.FLOAT,false,32,12);gl.vertexAttribPointer(2,1,gl.FLOAT,false,32,28);gl.drawArrays(gl.POINTS,0,verts.length/8);gl.disableVertexAttribArray(0);gl.disableVertexAttribArray(1);gl.disableVertexAttribArray(2);}
  function drawSolidQ(c,r,g,b,a){var v=new Float32Array([c[0][0],c[0][1],c[0][2],r,g,b,a,c[1][0],c[1][1],c[1][2],r,g,b,a,c[2][0],c[2][1],c[2][2],r,g,b,a,c[0][0],c[0][1],c[0][2],r,g,b,a,c[2][0],c[2][1],c[2][2],r,g,b,a,c[3][0],c[3][1],c[3][2],r,g,b,a]);gl.useProgram(pLine);gl.uniformMatrix4fv(uMVP_l,false,mvp);gl.bindBuffer(gl.ARRAY_BUFFER,bLine);gl.bufferData(gl.ARRAY_BUFFER,v,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(0,3,gl.FLOAT,false,28,0);gl.vertexAttribPointer(1,4,gl.FLOAT,false,28,12);gl.drawArrays(gl.TRIANGLES,0,6);gl.disableVertexAttribArray(0);gl.disableVertexAttribArray(1);}

  var _imgTex = null;
  function updateImgTex() {
    if(!_camImage||!_camImage.complete||_camImage.naturalWidth===0)return;
    if(!_imgTex) _imgTex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,_imgTex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,_camImage);
  }
  function drawTexQ(corners,alpha){
    var v=new Float32Array([corners[0][0],corners[0][1],corners[0][2],0,0,corners[1][0],corners[1][1],corners[1][2],1,0,corners[2][0],corners[2][1],corners[2][2],1,1,corners[3][0],corners[3][1],corners[3][2],0,1]);
    gl.useProgram(pTex);gl.uniformMatrix4fv(uMVP_t,false,mvp);gl.uniform1i(uTex_t,0);gl.uniform1f(uAlpha_t,alpha);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,_imgTex);
    gl.bindBuffer(gl.ARRAY_BUFFER,bTex);gl.bufferData(gl.ARRAY_BUFFER,v,gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(0,3,gl.FLOAT,false,20,0);gl.vertexAttribPointer(1,2,gl.FLOAT,false,20,12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bTexIdx);gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);
    gl.disableVertexAttribArray(0);gl.disableVertexAttribArray(1);
  }

  var hudC,hudX;
  function initHud(){hudC=document.createElement('canvas');hudC.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';canvas.parentNode.appendChild(hudC);}
  function resizeHud(){var r=canvas.getBoundingClientRect(),d=window.devicePixelRatio||1;hudC.width=Math.round(r.width*d);hudC.height=Math.round(r.height*d);hudX=hudC.getContext('2d');hudX.scale(d,d);}

  var _camAz=205,_camEl=25,_camDist=5.0,_camZoom=1.0;
  var CW,CH,mvp=m4c(),viewM=m4c(),projM=m4c();

  function updateMVP(){
    var ar=CW/CH,fov=(45/_camZoom)*Math.PI/180;
    m4c_persp(projM,fov,ar,0.1,100);
    var azR=_camAz*Math.PI/180,elR=_camEl*Math.PI/180;
    var ex=_camDist*Math.cos(elR)*Math.sin(azR),ey=_camDist*Math.cos(elR)*Math.cos(azR),ez=_camDist*Math.sin(elR);
    m4c_lookAt(viewM,ex,ey,ez,0,0,0,0,0,1);
    m4c_mul(mvp,projM,viewM);
  }
  function proj3to2(x,y,z){var m=mvp;var cx=m[0]*x+m[4]*y+m[8]*z+m[12],cy=m[1]*x+m[5]*y+m[9]*z+m[13],cw=m[3]*x+m[7]*y+m[11]*z+m[15];if(Math.abs(cw)<0.0001)cw=0.0001;var r=canvas.getBoundingClientRect();return{x:(cx/cw*0.5+0.5)*r.width,y:(1-(cy/cw*0.5+0.5))*r.height};}
  function unprojectGround(sx,sy){
    var r=canvas.getBoundingClientRect();var nx=(sx/r.width)*2-1,ny=1-(sy/r.height)*2;
    var azR=_camAz*Math.PI/180,elR=_camEl*Math.PI/180;
    var ex=_camDist*Math.cos(elR)*Math.sin(azR),ey=_camDist*Math.cos(elR)*Math.cos(azR),ez=_camDist*Math.sin(elR);
    var fx=-ex,fy=-ey,fz=-ez;var fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;fx/=fl;fy/=fl;fz/=fl;
    var rx=fy*1-fz*0,ry=fz*0-fx*1,rz=fx*0-fy*0;var rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1;rx/=rl;ry/=rl;rz/=rl;
    var ux=ry*fz-rz*fy,uy=rz*fx-rx*fz,uz=rx*fy-ry*fx;
    var fov=(45/_camZoom)*Math.PI/180,hH=Math.tan(fov/2),ar=CW/CH,hW=hH*ar;
    var dx=fx+rx*nx*hW+ux*ny*hH,dy=fy+ry*nx*hW+uy*ny*hH,dz=fz+rz*nx*hW+uz*ny*hH;
    if(Math.abs(dz)<0.0001)return{x:ex,y:ey};var t=-ez/dz;return{x:ex+dx*t,y:ey+dy*t};
  }
  function camSpherical(az,el,ds){var a=az*Math.PI/180,e=el*Math.PI/180;var r=0.3+((ds-0.6)/3.4)*0.8;return{x:r*Math.cos(e)*Math.sin(a),y:-r*Math.cos(e)*Math.cos(a),z:r*Math.sin(e)};}

  function mkGrid(){var v=[],R=1.8,N=8;for(var i=-N;i<=N;i++){var g=i/N*R;v.push(-R,g,0,1,1,1,0.05,R,g,0,1,1,1,0.05);v.push(g,-R,0,1,1,1,0.05,g,R,0,1,1,1,0.05);}return new Float32Array(v);}
  function mkRing(radius,r,g,b,a,n){var v=[],N=n||64;for(var i=0;i<=N;i++){var t=i/N*Math.PI*2;v.push(radius*Math.cos(t),radius*Math.sin(t),0,r,g,b,a);}return new Float32Array(v);}
  function mkArc(azDeg,radius,r,g,b,a){var v=[],azR=azDeg*Math.PI/180,d={x:Math.sin(azR),y:-Math.cos(azR)};for(var i=0;i<=32;i++){var ang=(-90+180*i/32)*Math.PI/180;v.push(d.x*radius*Math.cos(ang),d.y*radius*Math.cos(ang),radius*Math.sin(ang),r,g,b,a);}return new Float32Array(v);}

  function drawCanvas() {
    if(!gl)return; updateMVP();
    gl.viewport(0,0,CW,CH);
    gl.clearColor(0.14,0.14,0.14,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);

    var v=getValues(), camPos=camSpherical(v.az,v.el,v.ds);
    var lightR=0.3+((v.ds-0.6)/3.4)*0.8;

    gl.depthMask(true); gl.disable(gl.BLEND);
    var cW=0.45,cH=0.6;var hasImg=_camImage&&_camImage.complete&&_camImage.naturalWidth>0;
    if(hasImg){var asp=_camImage.naturalWidth/_camImage.naturalHeight;if(asp>1)cH=cW/asp;else cW=cH*asp;}
    var corners=[[-cW,0,cH],[cW,0,cH],[cW,0,-cH],[-cW,0,-cH]];
    if(hasImg&&_imgTex){drawTexQ(corners,1.0);}else{drawSolidQ(corners,0.18,0.18,0.18,0.9);}

    gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    drawLines(mkGrid(),gl.LINES);
    var ox=0.06;drawLines(new Float32Array([-ox,0,0,1,1,1,0.2,ox,0,0,1,1,1,0.2,0,-ox,0,1,1,1,0.2,0,ox,0,1,1,1,0.2,0,0,-ox,1,1,1,0.2,0,0,ox,1,1,1,0.2]),gl.LINES);
    var azAct=_activeHandle==='azimuth',azA=azAct?0.8:0.3;
    drawLines(mkRing(lightR,COL_AZ[0],COL_AZ[1],COL_AZ[2],azA),gl.LINE_STRIP);
    if(azAct)drawLines(mkRing(lightR,COL_AZ[0],COL_AZ[1],COL_AZ[2],0.5),gl.LINE_STRIP);
    var elAct=_activeHandle==='elevation',elA=elAct?0.8:0.3;
    drawLines(mkArc(v.az,lightR,COL_EL[0],COL_EL[1],COL_EL[2],elA),gl.LINE_STRIP);
    if(elAct)drawLines(mkArc(v.az,lightR,COL_EL[0],COL_EL[1],COL_EL[2],0.5),gl.LINE_STRIP);
    if(!hasImg||!_imgTex){var fv=[];for(var ci=0;ci<4;ci++){var c1=corners[ci],c2=corners[(ci+1)%4];fv.push(c1[0],c1[1],c1[2],1,1,1,0.15,c2[0],c2[1],c2[2],1,1,1,0.15);}drawLines(new Float32Array(fv),gl.LINES);}

    gl.disable(gl.DEPTH_TEST);
    var gx=camPos.x,gy=camPos.y,dsAct=_activeHandle==='distance';
    drawLines(new Float32Array([0,0,0,COL_AZ[0],COL_AZ[1],COL_AZ[2],azAct?0.6:0.25,gx,gy,0,COL_AZ[0],COL_AZ[1],COL_AZ[2],azAct?0.6:0.25,gx,gy,0,COL_EL[0],COL_EL[1],COL_EL[2],elAct?0.6:0.25,camPos.x,camPos.y,camPos.z,COL_EL[0],COL_EL[1],COL_EL[2],elAct?0.6:0.25,0,0,0,COL_DS[0],COL_DS[1],COL_DS[2],dsAct?0.5:0.15,camPos.x,camPos.y,camPos.z,COL_DS[0],COL_DS[1],COL_DS[2],dsAct?0.5:0.15]),gl.LINES);
    drawPoints(new Float32Array([gx,gy,0,1,1,1,0.25,7]));
    drawPoints(new Float32Array([camPos.x,camPos.y,camPos.z,COL_DS[0],COL_DS[1],COL_DS[2],1.0,dsAct?26:20]));
    drawPoints(new Float32Array([camPos.x,camPos.y,camPos.z,0.22,0.28,0.31,0.9,14]));
    drawPoints(new Float32Array([camPos.x,camPos.y,camPos.z,0.47,0.56,0.61,0.9,8]));

    gl.depthMask(true);gl.enable(gl.DEPTH_TEST);
    drawHud(v);
  }

  function drawHud(v) {
    if(!hudX)return;var r=canvas.getBoundingClientRect(),w=r.width,h=r.height;hudX.clearRect(0,0,w,h);
    var ly=14;hudX.fillStyle='rgba(0,0,0,0.4)';hudX.fillRect(w*0.2,2,w*0.6,20);
    hudX.font='bold '+Math.max(10,w*0.026)+'px sans-serif';hudX.textAlign='center';hudX.globalAlpha=0.9;
    hudX.fillStyle='#54c2ff';hudX.fillText('\u25cf 方位',w*0.35,ly);
    hudX.fillStyle='#bb73ff';hudX.fillText('\u25cf 仰角',w*0.5,ly);
    hudX.fillStyle='#ff9438';hudX.fillText('\u25cf 距离',w*0.65,ly);
    hudX.globalAlpha=1;
    var cp=proj3to2(v.az!==undefined?camSpherical(v.az,v.el,v.ds).x:0,camSpherical(v.az,v.el,v.ds).y,camSpherical(v.az,v.el,v.ds).z);
    hudX.font='bold '+Math.max(9,w*0.02)+'px sans-serif';hudX.fillStyle='rgba(255,255,255,0.7)';hudX.textAlign='center';
    hudX.fillText(v.az+'\u00b0 / '+v.el+'\u00b0 / '+v.ds.toFixed(1),cp.x,cp.y-18);
    var azCn=nearestKey(AZ_CN,v.az),elCn=nearestKey(EL_CN,v.el),dsCn=nearestKey(DS_CN,v.ds);
    var lb=azCn+' | '+elCn+' | '+dsCn;
    hudX.font='bold '+Math.max(10,w*0.026)+'px sans-serif';
    var tw=hudX.measureText(lb).width+28,bH=22,bY=h-bH-4;
    hudX.fillStyle='rgba(0,0,0,0.5)';hudX.fillRect(w/2-tw/2,bY,tw,bH);
    hudX.fillStyle='#e0e0e0';hudX.textAlign='center';hudX.fillText(lb,w/2,bY+bH-6);
    if(!_camImage||!_camImage.complete||_camImage.naturalWidth===0){var c0=proj3to2(0,0,0);hudX.font=(w*0.04)+'px sans-serif';hudX.fillStyle='rgba(255,255,255,0.25)';hudX.textAlign='center';hudX.fillText('\ud83d\udcf7',c0.x,c0.y+5);}
  }

  var _activeHandle=null,_snapAnimId=null,handleDrag=null,_orbitDrag=false,_orbitLx=0,_orbitLy=0,_dragSDs=1,_dragSMx=0,_dragSMy=0;

  function distToCurve2d(mx,my,pts,n){var mn=Infinity;for(var i=0;i<=n;i++){var t=i/n*Math.PI*2;var v=getValues();var lightR=0.3+((v.ds-0.6)/3.4)*0.8;var p=proj3to2(lightR*Math.cos(t),lightR*Math.sin(t),0);var d=Math.hypot(mx-p.x,my-p.y);if(d<mn)mn=d;}return mn;}
  function distToArc2d(mx,my,n){var mn=Infinity,v=getValues(),lightR=0.3+((v.ds-0.6)/3.4)*0.8,azR=v.az*Math.PI/180,dir={x:Math.sin(azR),y:-Math.cos(azR)};for(var i=0;i<=n;i++){var ang=(-90+180*i/n)*Math.PI/180;var p=proj3to2(dir.x*lightR*Math.cos(ang),dir.y*lightR*Math.cos(ang),lightR*Math.sin(ang));var d=Math.hypot(mx-p.x,my-p.y);if(d<mn)mn=d;}return mn;}
  function distToLine2d(mx,my,x0,y0,z0,x1,y1,z1,n){var mn=Infinity;for(var i=0;i<=n;i++){var t=i/n;var p=proj3to2(x0+(x1-x0)*t,y0+(y1-y0)*t,z0+(z1-z0)*t);var d=Math.hypot(mx-p.x,my-p.y);if(d<mn)mn=d;}return mn;}

  function hitTest(mx,my){
    var HP=20,HC=12,v=getValues(),cp=camSpherical(v.az,v.el,v.ds),fp=proj3to2(cp.x,cp.y,cp.z);
    if(Math.hypot(mx-fp.x,my-fp.y)<HP)return'distance';
    if(distToLine2d(mx,my,0,0,0,cp.x,cp.y,cp.z,20)<HC)return'distance';
    if(distToCurve2d(mx,my,null,48)<HC)return'azimuth';
    if(distToArc2d(mx,my,24)<HC)return'elevation';
    return null;
  }

  function snapAnimate(sAz,sEl,sDs,tAz,tEl,tDs){
    if(_snapAnimId)cancelAnimationFrame(_snapAnimId);var st=Date.now(),dur=200,azD=tAz-sAz;if(azD>180)azD-=360;if(azD<-180)azD+=360;
    function tick(){var t=Math.min((Date.now()-st)/dur,1),e=1-Math.pow(1-t,3),a=sAz+azD*e;if(a<0)a+=360;if(a>=360)a-=360;slAz.value=a;slEl.value=sEl+(tEl-sEl)*e;slDs.value=sDs+(tDs-sDs)*e;updateLabels();if(t<1)_snapAnimId=requestAnimationFrame(tick);else _snapAnimId=null;}tick();
  }

  canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
  canvas.addEventListener('mousedown',function(e){
    var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    if(e.button===2||e.button===1){_orbitDrag=true;_orbitLx=e.clientX;_orbitLy=e.clientY;canvas.style.cursor='move';return;}
    var hit=hitTest(mx,my);
    if(hit){handleDrag=hit;_activeHandle=hit;canvas.style.cursor='grabbing';if(hit==='distance'){_dragSDs=Number(slDs.value);_dragSMx=mx;_dragSMy=my;}}
    else{_orbitDrag=true;_orbitLx=e.clientX;_orbitLy=e.clientY;canvas.style.cursor='move';}
    drawCanvas();
  });
  canvas.addEventListener('mousemove',function(e){
    if(handleDrag||_orbitDrag)return;var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    var old=_activeHandle,h=hitTest(mx,my);
    if(h){_activeHandle=h;canvas.style.cursor='grab';}else{_activeHandle=null;canvas.style.cursor='crosshair';}
    if(_activeHandle!==old)drawCanvas();
  });
  var _docMoveHandler = function(e){
    if(_orbitDrag){var dx=e.clientX-_orbitLx,dy=e.clientY-_orbitLy;_camAz+=dx*0.5;_camEl=Math.max(-89,Math.min(89,_camEl+dy*0.5));_orbitLx=e.clientX;_orbitLy=e.clientY;updateMVP();drawCanvas();return;}
    if(!handleDrag)return;var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    if(handleDrag==='azimuth'){var gp=unprojectGround(mx,my);var az=Math.atan2(gp.x,-gp.y)*180/Math.PI;if(az<0)az+=360;if(az>=360)az=0;slAz.value=az;}
    if(handleDrag==='elevation'){var v=getValues(),azR=v.az*Math.PI/180,lightR=0.3+((v.ds-0.6)/3.4)*0.8,dir={x:Math.sin(azR),y:-Math.cos(azR)};var ac=proj3to2(0,0,0),hp=proj3to2(dir.x*lightR,dir.y*lightR,0),tp=proj3to2(0,0,lightR);var hDx=hp.x-ac.x,hDy=hp.y-ac.y,uDx=tp.x-ac.x,uDy=tp.y-ac.y;var hL=Math.sqrt(hDx*hDx+hDy*hDy)||1,uL=Math.sqrt(uDx*uDx+uDy*uDy)||1;var mDx=mx-ac.x,mDy=my-ac.y;var pH=(mDx*hDx+mDy*hDy)/hL,pU=(mDx*uDx+mDy*uDy)/uL;var elA=Math.atan2(pU,Math.max(pH,0.01))*180/Math.PI;slEl.value=Math.round(Math.max(-90,Math.min(90,elA)));}
    if(handleDrag==='distance'){var o2=proj3to2(0,0,0),v2=getValues(),cp2=camSpherical(v2.az,v2.el,_dragSDs),lp2=proj3to2(cp2.x,cp2.y,cp2.z);var rdx=lp2.x-o2.x,rdy=lp2.y-o2.y,rdL=Math.sqrt(rdx*rdx+rdy*rdy)||1;rdx/=rdL;rdy/=rdL;var mdx=mx-_dragSMx,mdy=my-_dragSMy;var proj=mdx*rdx+mdy*rdy;var sens=3.4/(r.width*0.3);slDs.value=Math.max(0.6,Math.min(4.0,_dragSDs+proj*sens));}
    updateLabels();
  };
  var _docUpHandler = function(e){
    if(_orbitDrag){_orbitDrag=false;canvas.style.cursor='crosshair';return;}
    if(handleDrag){var v=getValues();var tAz=Math.round(v.az/45)*45;if(tAz>=360)tAz=0;var tEl=Math.round(v.el/15)*15;tEl=Math.max(-90,Math.min(90,tEl));var dsS=[0.6,0.8,1.0,1.4,2.0,3.0,4.0];var tDs=dsS.reduce(function(p,c){return Math.abs(c-v.ds)<Math.abs(p-v.ds)?c:p;});snapAnimate(v.az,v.el,v.ds,tAz,tEl,tDs);handleDrag=null;_activeHandle=null;canvas.style.cursor='crosshair';}
  };
  document.addEventListener('mousemove', _docMoveHandler);
  document.addEventListener('mouseup', _docUpHandler);

  canvas.addEventListener('wheel',function(e){e.preventDefault();_camZoom=Math.max(0.5,Math.min(2.0,_camZoom+(e.deltaY>0?-0.05:0.05)));if(camZoomSlider)camZoomSlider.value=_camZoom;updateMVP();drawCanvas();});
  canvas.addEventListener('dblclick',function(e){if(e.button!==0)return;var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;if(hitTest(mx,my))return;_camAz=205;_camEl=25;_camZoom=1.0;if(camZoomSlider)camZoomSlider.value=1.0;updateMVP();drawCanvas();});

  slAz.addEventListener('input',updateLabels); slEl.addEventListener('input',updateLabels); slDs.addEventListener('input',updateLabels);
  $id('camAzReset').addEventListener('click',function(){slAz.value=0;updateLabels();}); $id('camElReset').addEventListener('click',function(){slEl.value=0;updateLabels();}); $id('camDsReset').addEventListener('click',function(){slDs.value=1.0;updateLabels();});
  var camZoomSlider=$id('camZoomSlider');if(camZoomSlider)camZoomSlider.addEventListener('input',function(){_camZoom=parseFloat(this.value)||1.0;updateMVP();updateLabels();});

  // 📷 加载图像
  var _captureActive = false;
  $id('btnCamCapture').addEventListener('click',function(){
    _captureActive = true;
    TileAPI.sendToHost('captureForChat', {});
  });
  var _captureResultHandler = function(data) {
    if (!_captureActive) return;
    _captureActive = false;
    if (!data || !data.success || !data.base64) { TileAPI.toast('图像捕获失败','error'); return; }
    _camImageB64 = data.base64;
    _camImage = new Image();
    _camImage.onload = function() { updateImgTex(); drawCanvas(); };
    _camImage.src = 'data:image/png;base64,' + data.base64;
    TileAPI.toast('图像已加载','success');
  };
  TileAPI.onHostMessage('captureForChatResult', _captureResultHandler);

  // Provider 按钮 (按可见槽位顺序, 含 momo;隐藏的第4格不在此列)
  function _updateProvBtns(prov) {
    TileAPI.slotOrder().forEach(function(p) {
      var btn = $id('camProv' + (p.charAt(0).toUpperCase() + p.slice(1)));
      if (btn) btn.classList.toggle('w10-btn-accent', p === prov);
    });
    _updateModelOptions(prov);
  }
  function _updateModelOptions(prov) {
    var sel = $id('camModelInput');
    if (!sel) return;
    var cfg = TileAPI.state.get('models.' + prov) || {};
    var keys = Object.keys(cfg);
    sel.innerHTML = keys.map(function(k) { return '<option value="'+k+'">'+((cfg[k] && cfg[k].name) || k)+'</option>'; }).join('') || '<option value="">(未配置)</option>';
  }
  var _curProvider = TileAPI.state.get('params.provider') || 'aji';
  _updateProvBtns(_curProvider);
  TileAPI.slotOrder().forEach(function(p) {
    var btn = $id('camProv' + (p.charAt(0).toUpperCase() + p.slice(1)));
    if (btn) btn.addEventListener('click', function() {
      _curProvider = p;
      _updateProvBtns(p);
    });
  });

  // 🚀 开始生成
  $id('btnCamGenerate').addEventListener('click', function() {
    var prompt = buildPrompt();
    var model = $id('camModelInput').value;
    var size = $id('camSizeInput').value;
    var aspect = $id('camAspectRatioInput').value;
    var batch = Number($id('camBatchInput').value) || 1;
    var timeout = Number($id('camTimeoutInput').value) || 3600;

    var apiKey = '';
    var apiBaseUrl = '';
    if (window._settingsGetActiveConnection) {
      var conn = window._settingsGetActiveConnection(_curProvider);
      apiKey = conn.key;
      apiBaseUrl = conn.url;
      if (!apiKey || !apiBaseUrl) {
        if (conn._grsKeyPending) TileAPI.toast('正在准备夏算力, 请稍后再试', 'info');
        else if (conn._grsNeedLogin) TileAPI.toast('夏算力托管需要登录 (顶栏账号区), 或切回「自带 Key」', 'error');
        else TileAPI.toast('请先在顶栏配置 '+_curProvider.toUpperCase()+' 的 URL 和 Key','error');
        return;
      }
    } else {
      apiKey = TileAPI.storage.get('connection.'+_curProvider+'.key') || '';
      apiBaseUrl = TileAPI.storage.get('connection.'+_curProvider+'.url') || '';
      if (!apiKey || !apiBaseUrl) { TileAPI.toast('请先在顶栏配置 '+_curProvider.toUpperCase()+' 的 URL 和 Key','error'); return; }
    }

    var taskId = 'cam_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
    var autoReturn = TileAPI.storage.get('output.autoReturn') !== false;

    var running = TileAPI.state.get('tasks.running') || {};
    running[taskId] = { batchSize: batch, startTime: Date.now(), success: 0, fail: 0, total: 0, model: '🎬 ' + model, provider: _curProvider };
    TileAPI.state.set('tasks.running', running);
    var meta = TileAPI.state.get('tasks.meta') || {};
    meta[taskId] = { countdown: timeout, timeoutSec: timeout, autoReturn: autoReturn, batchSize: batch };
    TileAPI.state.set('tasks.meta', meta);
    TileAPI.emit('tasks:updated');
    TileAPI.emit('task:started', { taskId: taskId, timeoutSec: timeout, batchSize: batch });

    TileAPI.sendToHost('recordableRunSingle', {
      engine: 'api',
      taskId: taskId,
      prompt: prompt,
      apiKey: apiKey,
      apiBaseUrl: apiBaseUrl,
      model: model,
      size: size,
      aspectRatio: aspect,
      batchSize: batch,
      timeout: timeout,
      refImages: [],
      provider: _curProvider,
      autoReturn: autoReturn,
      layerType: 'smartObject',
      antiMode: 0
    });
    TileAPI.toast('镜头生成任务已提交', 'success');
  });

  // 初始化
  function initCanvasSize(){
    var r=canvas.getBoundingClientRect(),d=window.devicePixelRatio||1;
    if (r.width <= 0) { setTimeout(initCanvasSize, 50); return; }
    // bug #67: 画布默认高=宽×0.75, 在矮屏笔记本上会把下方控件顶出可视区。
    //   给一个"不超过面板可视高度 55%"的上限, 高屏不受影响(仍是 0.75), 矮屏自动压扁腾出控件空间。
    var idealH = r.width * 0.75;
    var panel = canvas.closest('.w10-panel') || canvas.parentNode;
    var availH = (panel && panel.clientHeight) ? panel.clientHeight : window.innerHeight;
    var maxH = Math.max(140, Math.round(availH * 0.55));   // 至少留 140px 给画布, 别压没了
    var dispH = Math.min(idealH, maxH);
    canvas.width=Math.round(r.width*d);canvas.height=Math.round(dispH*d);canvas.style.height=Math.round(dispH)+'px';
    CW=canvas.width;CH=canvas.height;gl.viewport(0,0,CW,CH);
    resizeHud();updateMVP();
  }
  initShaders(); initBuffers(); initHud();
  initCanvasSize();
  updateLabels();

  var _resizeHandler = function(){ initCanvasSize(); drawCanvas(); };
  window.addEventListener('resize', _resizeHandler);

  return function cleanup() {
    document.removeEventListener('mousemove', _docMoveHandler);
    document.removeEventListener('mouseup', _docUpHandler);
    window.removeEventListener('resize', _resizeHandler);
    if (_snapAnimId) cancelAnimationFrame(_snapAnimId);
    // 注销 host 消息监听, 避免反复展开磁贴叠加(#10 同款泄漏)
    TileAPI.offHostMessage('captureForChatResult', _captureResultHandler);
  };
}

})();
