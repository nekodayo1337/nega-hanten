(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };

  const supported = typeof Worker !== 'undefined' && typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  if (!supported) {
    show('unsupported', true);
    show('pick', false);
    return;
  }

  const params = new URLSearchParams(location.search);
  const testUrl = params.get('test');

  let worker = null;
  let currentName = '';
  let busy = false;
  let objectUrl = null;

  function reset() {
    if (worker) { worker.terminate(); worker = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    busy = false;
    $('file').value = '';
    show('work', false);
    show('pick', true);
  }
  document.querySelectorAll('.reset').forEach((b) => b.addEventListener('click', reset));

  window.addEventListener('beforeunload', (e) => {
    if (busy) { e.preventDefault(); e.returnValue = ''; }
  });

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) start(f);
  });
  // ページのどこに落としてもブラウザが動画を開かないようにする
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) start(f); });

  function outName(name) {
    const base = name.replace(/\.[^.]+$/, '');
    return base + '_反転_補正.mp4';
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + '秒';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + '分' + (s ? s + '秒' : '');
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    return Math.round(bytes / 1e6) + ' MB';
  }

  function drawPreview(canvasId, p, data) {
    const c = $(canvasId);
    c.width = p.w; c.height = p.h;
    c.getContext('2d').putImageData(new ImageData(data, p.w, p.h), 0, 0);
  }

  function fail(message) {
    busy = false;
    ['analyzing', 'preview', 'encoding', 'done'].forEach((id) => show(id, false));
    $('errorText').textContent = message;
    show('error', true);
    if (testUrl) report({ ok: false, error: message });
  }

  function start(file) {
    if (worker) worker.terminate();
    currentName = file.name;
    show('pick', false);
    show('work', true);
    ['preview', 'encoding', 'done', 'error'].forEach((id) => show(id, false));
    show('analyzing', true);
    $('analyzeBar').style.width = '0%';
    $('fileName').textContent = file.name;
    busy = true;

    worker = new Worker('worker.js');
    worker.onerror = (e) => fail('うまく動きませんでした：' + (e.message || '原因がわかりません'));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'analyzeProgress') {
        $('analyzeBar').style.width = Math.round(m.done / m.total * 100) + '%';
      } else if (m.type === 'analyzed') {
        busy = false;
        onAnalyzed(m.result);
      } else if (m.type === 'encodeProgress') {
        const r = m.done / m.total;
        $('encodeBar').style.width = (r * 100).toFixed(1) + '%';
        const left = r > 0.02 ? (m.elapsed / 1000) * (1 - r) / r : null;
        $('encodeText').textContent = '書き出しています… ' + Math.floor(r * 100) + '%' +
          (left != null ? '（残り約' + fmtTime(left) + '）' : '');
      } else if (m.type === 'done') {
        busy = false;
        onDone(m.blob);
      } else if (m.type === 'debug') {
        if (testUrl) report({ ok: true, stage: 'debug', info: m.info });
      } else if (m.type === 'error') {
        fail(m.message);
      }
    };
    const lvParam = testUrl && params.get('levels');
    const levels = lvParam ? (() => { const n = lvParam.split(',').map(Number); return { r: [n[0], n[1]], g: [n[2], n[3]], b: [n[4], n[5]] }; })() : null;
    worker.postMessage({ type: 'analyze', file, levels, debug: !!testUrl });
  }

  let lastAnalysis = null;
  function onAnalyzed(r) {
    lastAnalysis = r;
    show('analyzing', false);
    drawPreview('before', r.preview, r.preview.before);
    drawPreview('after', r.preview, r.preview.after);
    const side = r.crop.x, top = r.crop.y;
    const parts = [];
    if (side || top) {
      parts.push('黒い帯：' + (side ? '左右 ' + side + 'px' : '') + (side && top ? '・' : '') + (top ? '上下 ' + top + 'px' : ''));
    } else {
      parts.push('黒い帯：なし');
    }
    parts.push('色の範囲：赤 ' + r.levels.r.join('〜') + '・緑 ' + r.levels.g.join('〜') + '・青 ' + r.levels.b.join('〜'));
    parts.push(fmtTime(r.duration) + '・' + r.width + '×' + r.height);
    if (r.audio && r.audio.unsupported) parts.push('音声はこの形式に対応していないため入りません');
    if (!r.audio) parts.push('音声なし');
    $('details').textContent = parts.join('　/　');
    show('preview', true);
    if (testUrl) {
      report({ ok: true, stage: 'analyzed', analysis: Object.assign({}, r, { preview: undefined }) });
      if (params.get('stop') !== 'preview') beginEncode();
    }
  }

  function beginEncode() {
    show('preview', false);
    show('encoding', true);
    $('encodeBar').style.width = '0%';
    $('encodeText').textContent = '書き出しています…';
    busy = true;
    worker.postMessage({ type: 'encode', bitrateScale: testUrl && params.get('br') ? Number(params.get('br')) : undefined });
  }
  $('start').addEventListener('click', beginEncode);

  function onDone(blob) {
    show('encoding', false);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    const name = outName(currentName);
    const a = $('save');
    a.href = objectUrl;
    a.download = name;
    $('doneInfo').textContent = name + '（' + fmtSize(blob.size) + '）。「保存する」を押すと、ダウンロードのフォルダに入ります。';
    show('done', true);
    if (worker) { worker.terminate(); worker = null; }
    if (testUrl) upload(blob, name);
  }

  /* ---- 試験用（?test=動画のURL）：自動で通しで動かし、結果を試験用サーバー（動画と同じところ）へ送る ---- */
  const devBase = testUrl ? new URL('/', new URL(testUrl, location.href)).href : '';
  function report(obj) {
    fetch(devBase + 'dev/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ ua: navigator.userAgent }, obj)) }).catch(() => {});
  }
  async function upload(blob, name) {
    const t = params.get('tag') || 'out';
    await fetch(devBase + 'dev/upload?name=' + encodeURIComponent(t + '.mp4'), { method: 'PUT', body: blob });
    report({ ok: true, stage: 'uploaded', name, size: blob.size });
  }
  if (testUrl) {
    fetch(testUrl).then((r) => r.blob()).then((b) => {
      const name = decodeURIComponent(testUrl.split('/').pop());
      start(new File([b], name, { type: 'video/mp4' }));
    }).catch((e) => fail('試験用の動画を読めませんでした：' + e));
  }
})();
