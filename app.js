'use strict';

const $ = selector => document.querySelector(selector);
const state = { sample: null, mode: 'bass', version: 'a', context: null, buffers: new Map(), sources: [], gains: [], master: null, playing: false, position: 0, startedAt: 0, startOffset: 0, loop: null, request: 0, ready: false };
const label = { bass: ['原始 Bass', '编辑后的 Bass'], mix: ['原始 Full Mix', '编辑后的 Full Mix'] };
const names = { bass: ['bass_original', 'bass_edited'], mix: ['mix_original', 'mix_edited'] };
const status = (message, error = false) => { $('#status').textContent = message; $('#status').classList.toggle('error', error); };
const timeLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;

function currentPosition() {
  if (!state.playing) return state.position;
  let position = state.startOffset + state.context.currentTime - state.startedAt;
  if (state.loop && position >= state.loop[1]) position = state.loop[0] + (position - state.loop[0]) % (state.loop[1] - state.loop[0]);
  return Math.max(0, Math.min(state.sample.duration, position));
}

function stopSources() {
  state.sources.forEach(source => { try { source.stop(); } catch (_) {} source.disconnect(); });
  state.gains.forEach(gain => gain.disconnect());
  state.sources = []; state.gains = [];
}

function pause() {
  state.position = currentPosition(); state.playing = false; stopSources();
  $('#play-label').textContent = '播放'; $('#play').firstElementChild.textContent = '▶';
}

async function audioContext() {
  if (!state.context) {
    state.context = new (window.AudioContext || window.webkitAudioContext)();
    state.master = state.context.createGain(); state.master.connect(state.context.destination); updateGain();
  }
  return state.context;
}

async function loadMode(mode) {
  const context = await audioContext();
  await Promise.all(names[mode].map(async name => {
    if (state.buffers.has(name)) return;
    const response = await fetch(state.sample.audio[name].url);
    if (!response.ok) throw new Error(`音频请求失败 (${response.status})`);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    if (Math.abs(buffer.duration - state.sample.duration) > 0.002) throw new Error('音频长度与公开样例不一致');
    state.buffers.set(name, buffer);
  }));
}

async function play() {
  if (!state.ready) return;
  const context = await audioContext(); await context.resume();
  if (state.playing) return;
  if (state.position >= state.sample.duration - 0.002) state.position = state.loop ? state.loop[0] : 0;
  if (state.loop && (state.position < state.loop[0] || state.position >= state.loop[1])) state.position = state.loop[0];
  stopSources();
  const when = context.currentTime + 0.015;
  names[state.mode].forEach((name, index) => {
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = state.buffers.get(name); source.loop = Boolean(state.loop);
    if (state.loop) { source.loopStart = state.loop[0]; source.loopEnd = state.loop[1]; }
    gain.gain.value = (index === 0 ? 'a' : 'b') === state.version ? 1 : 0;
    source.connect(gain); gain.connect(state.master); source.start(when, state.position);
    state.sources.push(source); state.gains.push(gain);
  });
  state.startOffset = state.position; state.startedAt = when; state.playing = true;
  $('#play-label').textContent = '暂停'; $('#play').firstElementChild.textContent = 'Ⅱ';
}

function togglePlay() { if (state.playing) pause(); else play().catch(error => status(error.message, true)); }

function seek(position) {
  const wasPlaying = state.playing; if (wasPlaying) pause();
  state.position = Math.max(0, Math.min(state.sample.duration, position));
  if (state.loop && (state.position < state.loop[0] || state.position >= state.loop[1])) { state.loop = null; $('#loop').value = 'off'; }
  if (wasPlaying) play().catch(error => status(error.message, true));
  render();
}

function setVersion(version) {
  state.version = version;
  document.querySelectorAll('[data-version]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.version === version)));
  ['a', 'b'].forEach((key, index) => {
    $(`#row-${key}`).classList.toggle('active', version === key);
    if (state.gains[index]) {
      const gain = state.gains[index].gain, now = state.context.currentTime;
      gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); gain.linearRampToValueAtTime(version === key ? 1 : 0, now + 0.008);
    }
  });
}

async function setMode(mode) {
  const request = ++state.request, wasPlaying = state.playing;
  if (wasPlaying) pause(); state.ready = false; state.mode = mode;
  $('#play').disabled = true; $('#play-label').textContent = '加载音频';
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  ['a', 'b'].forEach((key, index) => { $(`#row-${key} .wave-label>span`).innerHTML = `<b>${key.toUpperCase()}</b> ${label[mode][index]}`; });
  status(`正在载入${mode === 'bass' ? ' Bass' : ' Full Mix'} 原版与编辑版…`); render();
  try {
    await loadMode(mode); if (request !== state.request) return;
    state.ready = true; $('#play').disabled = false; $('#play-label').textContent = '播放';
    status('已就绪 · 两个版本共享播放位置与监听音量。');
    if (wasPlaying) await play();
  } catch (error) { if (request === state.request) { $('#play-label').textContent = '载入失败'; status(`${error.message}；请刷新页面重试。`, true); } }
}

function updateGain() {
  const db = Number($('#gain').value);
  $('#gain-label').textContent = `${db >= 0 ? '+' : ''}${db.toFixed(Number.isInteger(db) ? 0 : 1)} dB`;
  if (state.master) {
    const gain = state.master.gain, target = 10 ** (db / 20), now = state.context.currentTime;
    gain.cancelScheduledValues(now);
    if (state.playing) { gain.setValueAtTime(gain.value, now); gain.linearRampToValueAtTime(target, now + 0.015); }
    else gain.value = target;
  }
}

function drawWave(canvas, peaks, position) {
  const box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(box.width * dpr)), height = Math.round(box.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = box.width, h = box.height, top = 19, bottom = h - 22, middle = (top + bottom) / 2, scale = (bottom - top) / 2 / state.sample.waveform_scale;
  ctx.clearRect(0, 0, w, h);
  const startX = state.sample.selection.start / state.sample.duration * w, endX = state.sample.selection.end / state.sample.duration * w;
  ctx.fillStyle = '#fbe9e5'; ctx.fillRect(startX, 0, endX - startX, bottom + 1);
  ctx.strokeStyle = '#dfb3aa'; ctx.lineWidth = 1;
  [startX, endX].forEach(x => { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); });
  ctx.font = '10px system-ui'; ctx.fillStyle = '#ad483c'; ctx.textAlign = 'center'; ctx.fillText('8–12 s', (startX + endX) / 2, 12);
  ctx.strokeStyle = '#e4e8e2'; ctx.beginPath(); ctx.moveTo(0, middle); ctx.lineTo(w, middle); ctx.stroke();
  ctx.lineWidth = Math.max(0.7, w / peaks.length * 0.8); ctx.strokeStyle = '#567b6e'; ctx.beginPath();
  for (let i = 0; i < peaks.length; i++) { const x = (i + 0.5) / peaks.length * w; ctx.moveTo(x, middle - peaks[i][1] * scale); ctx.lineTo(x, middle - peaks[i][0] * scale); }
  ctx.stroke(); ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = '#7b8580';
  for (let second = 0; second <= state.sample.duration; second += 4) { const x = second / state.sample.duration * w; ctx.textAlign = second === 0 ? 'left' : second === state.sample.duration ? 'right' : 'center'; ctx.fillText(`${second}s`, x, h - 5); }
  const x = position / state.sample.duration * w; ctx.fillStyle = '#2675d8'; ctx.fillRect(Math.min(w - 2, x), 0, 2, bottom + 1); ctx.beginPath(); ctx.arc(Math.min(w - 3, Math.max(3, x + 1)), 4, 3, 0, Math.PI * 2); ctx.fill();
  canvas.setAttribute('aria-valuenow', position.toFixed(2)); canvas.setAttribute('aria-valuetext', `${position.toFixed(2)} 秒，共 ${state.sample.duration} 秒`);
}

function render() {
  if (!state.sample) return;
  const position = currentPosition();
  $('#clock').innerHTML = `${timeLabel(position)} <span>/ ${timeLabel(state.sample.duration)}</span>`;
  names[state.mode].forEach((name, index) => drawWave($(`#wave-${index ? 'b' : 'a'}`), state.sample.audio[name].waveform, position));
  if (state.playing && !state.loop && position >= state.sample.duration) pause();
}

function frame() { if (state.playing) render(); requestAnimationFrame(frame); }

async function initialize() {
  try {
    const response = await fetch('./sample.json'); if (!response.ok) throw new Error(`样例信息载入失败 (${response.status})`);
    state.sample = await response.json();
    $('#caption').textContent = state.sample.caption_en; $('#format-note').textContent = state.sample.audio_format_note;
    $('#gain').max = state.sample.monitor.maximum_db; $('#gain').value = state.sample.monitor.default_db; updateGain();
    const downloadLabels = ['原 Bass', '编辑 Bass', '原 Full Mix', '编辑 Full Mix'];
    ['bass_original', 'bass_edited', 'mix_original', 'mix_edited'].forEach((name, index) => { const link = document.createElement('a'); link.href = state.sample.audio[name].url; link.download = ''; link.textContent = `${downloadLabels[index]} ↓ WAV`; $('#downloads').append(link); });
    document.querySelectorAll('[data-version]').forEach(button => button.addEventListener('click', () => setVersion(button.dataset.version)));
    document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
    $('#play').addEventListener('click', togglePlay); $('#gain').addEventListener('input', updateGain);
    $('#loop').addEventListener('change', () => {
      const wasPlaying = state.playing; if (wasPlaying) pause();
      state.loop = { off: null, selection: [8, 12], left: [7, 9], right: [11, 13], all: [0, 32] }[$('#loop').value];
      if (state.loop) state.position = state.loop[0];
      render(); if (wasPlaying) play().catch(error => status(error.message, true));
    });
    document.querySelectorAll('canvas').forEach(canvas => {
      canvas.addEventListener('click', event => { const box = canvas.getBoundingClientRect(); seek((event.clientX - box.left) / box.width * state.sample.duration); canvas.focus({ preventScroll: true }); });
      canvas.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.code)) { event.preventDefault(); seek(event.code === 'Home' ? 0 : event.code === 'End' ? state.sample.duration : currentPosition() + (event.code === 'ArrowRight' ? 1 : -1)); } });
    });
    document.addEventListener('keydown', event => { if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.matches('input,textarea,select,[contenteditable="true"],summary')) return; event.preventDefault(); togglePlay(); });
    window.addEventListener('resize', render); await setMode('bass'); render(); requestAnimationFrame(frame);
  } catch (error) { status(error.message, true); $('#play-label').textContent = '载入失败'; }
}
initialize();
