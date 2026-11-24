const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let currentPage = 'vod';
let vodPage = 1, vodTotalPages = 1, vodCat = '*';
let tvPage = 1, tvTotalPages = 1, tvGenre = '*';
let detailPrev = 'vod';
let detailStreamUrl = '';
let detailFormat = 'mp4';
let detailNativeFormat = 'mp4';
let detailQuality = 'best';
let detailMovieName = '';
let detailMovieId = '';
let dlPollTimer = null;

async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}
async function post(url, body) {
  return api(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
}

function nav(page) {
  currentPage = page;
  $$('#main .page').forEach(p => p.classList.remove('active'));
  $(`#page-${page}`).classList.add('active');
  $$('#sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  if (page === 'downloads') loadDownloads();
}

// ---- connect ----
async function connect() {
  $('#conn-status').textContent = '● Connecting...';
  $('#conn-status').className = 'status';
  const r = await post('/api/connect', {});
  if (r.ok) {
    $('#conn-status').textContent = '● Connected';
    $('#conn-status').className = 'status ok';
    $('#user-name').textContent = r.profile.fname || '';
    $('#user-mac').textContent = 'MAC: ' + (r.profile.mac || '');
    const rawExp = (r.profile.expire || '').substring(0, 10);
    let expLabel = rawExp;
    try {
      const d = new Date(rawExp + 'T00:00:00');
      if (!isNaN(d)) expLabel = d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
    } catch(e) {}
    $('#user-exp').textContent = 'Expires on: ' + expLabel;
    loadCategories();
    loadTvGenres();
  } else {
    $('#conn-status').textContent = '● Failed: ' + (r.error || 'Unknown');
    $('#conn-status').className = 'status';
  }
}

// ---- VOD ----
async function loadCategories() {
  const r = await api('/api/categories');
  if (!r.ok) return;
  const sel = $('#vod-cat');
  sel.innerHTML = '<option value="*">All</option>';
  r.data.filter(c => c.id !== '*').forEach(c => {
    sel.innerHTML += `<option value="${c.id}">${esc(c.title)}</option>`;
  });
  loadVod();
}

function vodCatChange() {
  vodCat = $('#vod-cat').value;
  vodPage = 1;
  loadVod();
}

async function loadVod() {
  $('#vod-list').innerHTML = '<div class="empty">Loading...</div>';
  const r = await api(`/api/vod?cat=${vodCat}&page=${vodPage}`);
  if (!r.ok || !r.data || !r.data.data || !r.data.data.length) {
    $('#vod-list').innerHTML = '<div class="empty">No results.</div>';
    $('#vod-pag').innerHTML = '';
    return;
  }
  const d = r.data;
  const total = parseInt(d.total_items || 0);
  const per = Math.max(parseInt(d.max_page_items || 14), 1);
  vodTotalPages = Math.max(1, Math.ceil(total / per));
  $('#vod-title').textContent = `VOD Library (${total})`;
  renderVodList(d.data, '#vod-list');
  renderPag('#vod-pag', vodPage, vodTotalPages, p => { vodPage = p; loadVod(); });
}

function renderVodList(items, target) {
  const el = $(target);
  el.innerHTML = '';
  items.forEach((m, i) => {
    const parts = [];
    if (m.year && m.year !== '0') parts.push(m.year);
    if (m.rating_imdb && m.rating_imdb !== '0') parts.push('IMDb ' + m.rating_imdb);
    if (m.genre_str) parts.push(m.genre_str.substring(0, 50));
    if (m.is_series === '1' || m.is_series === 1) parts.push('📺 Series');
    const id = m.id || m.video_id;
    const div = document.createElement('div');
    div.className = 'card';
    div.dataset.movie = JSON.stringify(m);
    const poster = m.screenshot_uri || m.cover_big || m.logo || '';
    const posterSrc = poster ? '/api/poster?path=' + encodeURIComponent(poster) : '';
    const posterHtml = posterSrc
      ? `<img class="card-poster" src="${posterSrc}" onerror="this.outerHTML='<div class=\\'card-poster-ph\\'>🎬</div>'" loading="lazy" />`
      : '<div class="card-poster-ph">🎬</div>';
    div.innerHTML = `${posterHtml}<div class="info"><div class="title">${esc(m.name || 'Untitled')}</div>
      <div class="meta">${esc(parts.join('  |  '))}</div></div>
      <div class="actions"><button class="btn btn-accent">View</button></div>`;
    div.onclick = () => showDetail(id, div);
    div.querySelector('button').onclick = (e) => { e.stopPropagation(); showDetail(id, div); };
    el.appendChild(div);
  });
}

function renderPag(target, page, total, cb) {
  const el = $(target);
  if (total <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = '';
  const prev = document.createElement('button');
  prev.className = 'btn btn-dim btn-lg';
  prev.textContent = '◀  Previous';
  prev.disabled = page <= 1;
  prev.onclick = () => { if(page>1) cb(page-1); };

  const info = document.createElement('span');
  info.textContent = `Page ${page} of ${total}`;

  const next = document.createElement('button');
  next.className = 'btn btn-accent btn-lg';
  next.textContent = 'Next  ▶';
  next.disabled = page >= total;
  next.onclick = () => { if(page<total) cb(page+1); };

  el.appendChild(prev);
  el.appendChild(info);
  el.appendChild(next);
}

// ---- detail ----
async function showDetail(mid, cardEl) {
  detailPrev = currentPage;
  let movie = {};
  try { movie = JSON.parse(cardEl.dataset.movie); } catch(e) {}
  detailStreamUrl = '';

  $$('#main .page').forEach(p => p.classList.remove('active'));
  $('#page-detail').classList.add('active');

  $('#det-title').textContent = movie.name || 'Untitled';
  const posterWrap = $('#det-poster-wrap');
  const posterPath = movie.screenshot_uri || movie.cover_big || movie.logo || '';
  if (posterPath) {
    const posterSrc = '/api/poster?path=' + encodeURIComponent(posterPath);
    posterWrap.innerHTML = `<img class="detail-poster" src="${posterSrc}" onerror="this.outerHTML='<div class=\\'detail-poster-ph\\'>🎬</div>'" />`;
  } else {
    posterWrap.innerHTML = '<div class="detail-poster-ph">🎬</div>';
  }
  const grid = $('#det-info');
  grid.innerHTML = '';
  const isSeries = movie.is_series === '1' || movie.is_series === 1;
  const fields = [['Type', isSeries ? 'TV Series' : 'Movie'], ['Year', movie.year], ['Genre', movie.genre_str], ['IMDb', movie.rating_imdb],
                  ['Director', movie.director], ['Actors', movie.actors], ['Country', movie.country]];
  fields.forEach(([l, v]) => {
    if (v && v !== '0') grid.innerHTML += `<div class="lbl">${l}</div><div>${esc(String(v).substring(0,200))}</div>`;
  });
  $('#det-desc').textContent = (movie.description || '').substring(0, 600);
  $('#det-status').textContent = 'Loading stream info...';
  $('#det-status').style.color = 'var(--warn)';
  $('#det-url').style.display = 'none';
  $('#det-actions').innerHTML = '';
  $('#det-codec-info').style.display = 'none';
  $('#det-qual-picker').style.display = 'none';
  $('#det-fmt-picker').style.display = 'none';
  $('#det-fmt-hint').style.display = 'none';
  $('#det-encoder-info').style.display = 'none';
  $('#det-sub-picker').style.display = 'none';
  $('#det-series').style.display = 'none';
  detailQuality = 'best';
  detailMovieName = movie.name || 'Stream';
  detailMovieId = mid;

  const r = await api(`/api/movie/${mid}`);
  if (!r.ok || !r.data || !r.data.data || !r.data.data.length) {
    $('#det-status').textContent = 'No playable files found.';
    $('#det-status').style.color = 'var(--err)';
    return;
  }

  const firstItem = r.data.data[0];

  if (firstItem.is_season) {
    await showSeriesBrowser(mid, movie, r.data.data);
    return;
  }

  const fid = firstItem.id;
  const quality = firstItem.name || '';
  $('#det-status').textContent = quality ? `Quality: ${quality} — Getting URL...` : 'Getting URL...';

  const sr = await api(`/api/stream/${fid}`);
  if (!sr.ok || !sr.url) {
    $('#det-status').textContent = 'Failed to get stream.';
    $('#det-status').style.color = 'var(--err)';
    return;
  }
  detailStreamUrl = sr.url;
  $('#det-status').textContent = quality ? quality + ' — Probing format...' : 'Probing format...';
  $('#det-status').style.color = 'var(--warn)';
  $('#det-url').textContent = sr.url;
  $('#det-url').style.display = 'block';

  const safeName = movie.name || 'Stream';

  const pr = await api(`/api/probe?url=${encodeURIComponent(sr.url)}`);
  let nativeFmt = 'mp4';
  let vcodec = 'unknown', acodec = 'unknown';
  let qualities = [];
  if (pr.ok) {
    nativeFmt = pr.native || 'mp4';
    vcodec = pr.vcodec || 'unknown';
    acodec = pr.acodec || 'unknown';
    qualities = pr.qualities || [];
  }
  detailNativeFormat = nativeFmt;
  detailFormat = nativeFmt;
  detailQuality = 'best';

  const ci = $('#det-codec-info');
  ci.style.display = 'block';
  ci.innerHTML = `Video: <span>${esc(vcodec)}</span> &nbsp;|&nbsp; Audio: <span>${esc(acodec)}</span> &nbsp;|&nbsp; Native: <span>.${esc(nativeFmt)}</span>`;

  renderQualityPicker(qualities);
  renderFormatPicker(nativeFmt);
  renderEncoderInfo();
  renderSubtitlePicker(pr.subtitles || []);

  $('#det-status').textContent = quality || 'Stream ready.';
  $('#det-status').style.color = 'var(--success)';

  const actEl = $('#det-actions');
  actEl.innerHTML = '';

  const btnPlay = document.createElement('button');
  btnPlay.className = 'btn btn-success btn-lg';
  btnPlay.textContent = '▶  Stream in VLC';
  btnPlay.onclick = () => playStream(safeName);

  const btnDl = document.createElement('button');
  btnDl.className = 'btn btn-accent btn-lg';
  btnDl.id = 'btn-download';
  btnDl.textContent = '⬇  Download .' + nativeFmt.toUpperCase();
  btnDl.onclick = () => downloadStream(safeName);

  const btnCopy = document.createElement('button');
  btnCopy.className = 'btn btn-dim btn-lg';
  btnCopy.textContent = 'Copy URL';
  btnCopy.onclick = () => copyUrl();

  actEl.appendChild(btnPlay);
  actEl.appendChild(btnDl);
  actEl.appendChild(btnCopy);
}

function renderQualityPicker(qualities) {
  const el = $('#det-qual-picker');
  if (!qualities || qualities.length === 0) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = '<div class="qual-label">Quality:</div>';

  const bestBtn = document.createElement('button');
  bestBtn.className = 'qual-btn active';
  bestBtn.innerHTML = 'Best<span class="qual-tag">Max</span>';
  bestBtn.onclick = () => {
    detailQuality = 'best';
    el.querySelectorAll('.qual-btn').forEach(b => b.classList.remove('active'));
    bestBtn.classList.add('active');
  };
  el.appendChild(bestBtn);

  qualities.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'qual-btn';
    let inner = esc(q.label);
    if (q.bitrate_kbps) inner += `<span class="qual-br">${q.bitrate_kbps} kbps</span>`;
    btn.innerHTML = inner;
    btn.onclick = () => {
      detailQuality = String(q.height);
      el.querySelectorAll('.qual-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    el.appendChild(btn);
  });
}

function renderFormatPicker(nativeFmt) {
  const el = $('#det-fmt-picker');
  el.style.display = 'flex';
  el.innerHTML = '<div class="fmt-label">Download format:</div>';
  const formats = [
    {id: nativeFmt, label: '.' + nativeFmt.toUpperCase(), native: true},
  ];
  if (nativeFmt !== 'mkv') formats.push({id: 'mkv', label: '.MKV'});
  if (nativeFmt !== 'mp4') formats.push({id: 'mp4', label: '.MP4'});
  if (nativeFmt !== 'ts') formats.push({id: 'ts', label: '.TS'});
  formats.push({id: 'mp4-compat', label: '.MP4 (H.264)', desc: 'Re-encoded H.264+AAC CRF 18 — QuickTime/Windows compatible, near-lossless'});

  const hint = $('#det-fmt-hint');
  hint.style.display = 'block';
  hint.innerHTML = '<strong>Tip:</strong> Select <strong>.MP4 (H.264)</strong> if you want to play the file on Mac (QuickTime/Finder) or Windows without VLC. Other formats use the original codec — fastest download, full quality, but may require VLC to play.';

  formats.forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'fmt-btn' + (f.id === detailFormat ? ' active' : '');
    btn.innerHTML = f.label + (f.native ? '<span class="fmt-tag">Native</span>' : '');
    if (f.desc) btn.title = f.desc;
    btn.onclick = () => {
      detailFormat = f.id;
      el.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const dlBtn = $('#btn-download');
      if (dlBtn) {
        const ext = f.id === 'mp4-compat' ? 'MP4' : f.id.toUpperCase();
        dlBtn.textContent = '⬇  Download .' + ext;
      }
    };
    el.appendChild(btn);
  });
}

// ---- series browser ----
async function showSeriesBrowser(mid, movie, seasons) {
  const sb = $('#det-series');
  sb.style.display = 'block';
  sb.innerHTML = `<div class="sb-label">Seasons &amp; Episodes</div>
    <div class="sb-seasons" id="sb-seasons"></div>
    <div id="sb-episodes-wrap"></div>`;

  const seasonsEl = $('#sb-seasons');
  seasons.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'sb-season-btn' + (i === 0 ? ' active' : '');
    btn.textContent = s.name || `Season ${s.season_number || (i+1)}`;
    btn.onclick = () => {
      seasonsEl.querySelectorAll('.sb-season-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadEpisodes(mid, s.id, movie);
    };
    seasonsEl.appendChild(btn);
  });

  if (seasons.length > 0) {
    await loadEpisodes(mid, seasons[0].id, movie);
  }
  $('#det-status').textContent = `${seasons.length} season${seasons.length > 1 ? 's' : ''} available`;
  $('#det-status').style.color = 'var(--success)';
}

async function loadEpisodes(mid, seasonId, movie) {
  const wrap = $('#sb-episodes-wrap');
  wrap.innerHTML = '<div class="empty">Loading episodes...</div>';

  const r = await api(`/api/episodes/${mid}/${seasonId}`);
  if (!r.ok || !r.data || !r.data.data || !r.data.data.length) {
    wrap.innerHTML = '<div class="empty">No episodes found.</div>';
    return;
  }

  const eps = r.data.data;
  const showName = movie.name || 'Show';

  let html = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    <span class="sb-sel-info" id="sb-sel-count">0 selected</span>
    <span class="sb-select-all" id="sb-toggle-all">Select All</span>
  </div>
  <div class="sb-episodes" id="sb-ep-list"></div>
  <div class="sb-batch" id="sb-batch" style="display:none">
    <div class="sb-sel-info" id="sb-batch-info"></div>
    <button class="btn btn-success" id="sb-batch-vlc">▶ Play Selected in VLC</button>
    <button class="btn btn-accent" id="sb-batch-dl">⬇ Download Selected</button>
  </div>`;
  wrap.innerHTML = html;

  const listEl = $('#sb-ep-list');
  eps.forEach(ep => {
    const row = document.createElement('div');
    row.className = 'sb-ep';
    row.dataset.epId = ep.id;
    row.dataset.seasonId = seasonId;
    const dateStr = ep.date_add ? ep.date_add.split(' ')[0] : '';
    row.innerHTML = `<input type="checkbox" class="ep-cb" value="${ep.id}" data-name="${esc(ep.name || '')}">
      <div class="ep-name">${esc(ep.name || 'Episode ' + (ep.series_number || '?'))}</div>
      <div class="ep-date">${esc(dateStr)}</div>
      <div class="ep-actions">
        <button class="btn btn-success ep-play-btn">▶</button>
        <button class="btn btn-accent ep-dl-btn">⬇</button>
      </div>`;
    const playBtn = row.querySelector('.ep-play-btn');
    const dlBtn = row.querySelector('.ep-dl-btn');
    playBtn.onclick = async (e) => {
      e.stopPropagation();
      playBtn.textContent = '...';
      const url = await getEpisodeUrl(mid, seasonId, ep.id);
      if (url) {
        await post('/api/play', {url, name: showName + ' - ' + (ep.name || 'Episode')});
        playBtn.textContent = '✓';
      } else { playBtn.textContent = '✗'; }
      setTimeout(() => playBtn.textContent = '▶', 2000);
    };
    dlBtn.onclick = async (e) => {
      e.stopPropagation();
      dlBtn.textContent = '...';
      const url = await getEpisodeUrl(mid, seasonId, ep.id);
      if (url) {
        const epName = showName + ' - ' + (ep.name || 'Episode');
        await post('/api/download', {url, name: epName, format: 'mp4', quality: 'best', subtitles: []});
        dlBtn.textContent = '✓';
        startDlPolling();
      } else { dlBtn.textContent = '✗'; }
      setTimeout(() => dlBtn.textContent = '⬇', 2000);
    };
    listEl.appendChild(row);
  });

  const updateSelCount = () => {
    const checked = listEl.querySelectorAll('.ep-cb:checked').length;
    $('#sb-sel-count').textContent = checked + ' selected';
    $('#sb-batch').style.display = checked > 0 ? 'flex' : 'none';
    $('#sb-batch-info').textContent = checked + ' episode' + (checked > 1 ? 's' : '') + ' selected';
  };
  listEl.addEventListener('change', updateSelCount);

  let allSelected = false;
  $('#sb-toggle-all').onclick = () => {
    allSelected = !allSelected;
    listEl.querySelectorAll('.ep-cb').forEach(cb => cb.checked = allSelected);
    $('#sb-toggle-all').textContent = allSelected ? 'Deselect All' : 'Select All';
    updateSelCount();
  };

  $('#sb-batch-vlc').onclick = async () => {
    const cbs = listEl.querySelectorAll('.ep-cb:checked');
    for (const cb of cbs) {
      const epId = cb.value;
      const epName = cb.dataset.name || 'Episode';
      const row = cb.closest('.sb-ep');
      const url = await getEpisodeUrl(mid, row.dataset.seasonId, epId);
      if (url) await post('/api/play', {url, name: showName + ' - ' + epName});
    }
  };

  $('#sb-batch-dl').onclick = async () => {
    const cbs = listEl.querySelectorAll('.ep-cb:checked');
    for (const cb of cbs) {
      const epId = cb.value;
      const epName = cb.dataset.name || 'Episode';
      const row = cb.closest('.sb-ep');
      const url = await getEpisodeUrl(mid, row.dataset.seasonId, epId);
      if (url) {
        await post('/api/download', {url, name: showName + ' - ' + epName, format: 'mp4', quality: 'best', subtitles: []});
      }
    }
    startDlPolling();
    $('#det-status').textContent = `${cbs.length} download(s) queued — check Downloads page.`;
    $('#det-status').style.color = 'var(--success)';
  };
}

async function getEpisodeUrl(mid, seasonId, epId) {
  const r = await api(`/api/episode_files/${mid}/${seasonId}/${epId}`);
  if (r.ok && r.url) return r.url;
  return '';
}

async function renderEncoderInfo() {
  const el = $('#det-encoder-info');
  try {
    const r = await api('/api/encoders');
    if (!r.ok) { el.style.display = 'none'; return; }
    const cfg = await api('/api/config');
    const currentEnc = (cfg.ok && cfg.config && cfg.config.encoder) ? cfg.config.encoder : 'libx264';
    const enc = (r.encoders || []).find(e => e.id === currentEnc);
    const label = enc ? enc.name : currentEnc;
    el.style.display = 'block';
    el.innerHTML = `Encoder: <span class="enc-name">${esc(label)}</span> &nbsp;<span class="enc-hint">— Go to Settings to change encoder</span>`;
  } catch(e) {
    el.style.display = 'none';
  }
}

function renderSubtitlePicker(subs) {
  const el = $('#det-sub-picker');
  if (!subs || subs.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div class="sub-label">Subtitles (downloaded alongside video):</div><div class="sub-list" id="sub-list"></div>';
  const list = $('#sub-list');
  subs.forEach(s => {
    const item = document.createElement('label');
    item.className = 'sub-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.lang;
    cb.dataset.subLang = s.lang;
    item.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = s.name || s.lang;
    item.appendChild(txt);
    if (s.auto) {
      const tag = document.createElement('span');
      tag.className = 'sub-auto';
      tag.textContent = '(auto)';
      item.appendChild(tag);
    }
    list.appendChild(item);
  });
}

function getSelectedSubtitles() {
  const cbs = document.querySelectorAll('#sub-list input[type=checkbox]:checked');
  return Array.from(cbs).map(cb => cb.value);
}

async function playStream(name) {
  if (!detailStreamUrl) return;
  $('#det-status').textContent = 'Opening VLC...'; $('#det-status').style.color = 'var(--warn)';
  const r = await post('/api/play', {url: detailStreamUrl, name});
  if (r.player === 'vlc') { $('#det-status').textContent = 'VLC launched.'; $('#det-status').style.color = 'var(--success)'; }
  else { $('#det-status').textContent = 'VLC not found. Copy the URL and open manually.'; $('#det-status').style.color = 'var(--err)'; }
}

async function downloadStream(name) {
  if (!detailStreamUrl) return;
  const fmt = detailFormat || 'mp4';
  const ext = fmt === 'mp4-compat' ? 'MP4' : fmt.toUpperCase();
  $('#det-status').textContent = `Starting .${ext} download...`; $('#det-status').style.color = 'var(--warn)';
  const selectedSubs = getSelectedSubtitles();
  const r = await post('/api/download', {url: detailStreamUrl, name, format: fmt, quality: detailQuality, subtitles: selectedSubs});
  if (r.ok) {
    $('#det-status').textContent = 'Download started — check Downloads page.';
    $('#det-status').style.color = 'var(--success)';
    startDlPolling();
  } else {
    $('#det-status').textContent = 'Failed: ' + r.error;
    $('#det-status').style.color = 'var(--err)';
  }
}

function copyUrl() {
  if (!detailStreamUrl) return;
  navigator.clipboard.writeText(detailStreamUrl);
  $('#det-status').textContent = 'Copied to clipboard.'; $('#det-status').style.color = 'var(--success)';
}

function backFromDetail() {
  $$('#main .page').forEach(p => p.classList.remove('active'));
  $(`#page-${detailPrev}`).classList.add('active');
}

// ---- Live TV ----
async function loadTvGenres() {
  const r = await api('/api/tv_genres');
  if (!r.ok) return;
  const sel = $('#tv-genre');
  sel.innerHTML = '<option value="*">All</option>';
  r.data.forEach(g => { sel.innerHTML += `<option value="${g.id}">${esc(g.title)}</option>`; });
  loadTv();
}

function tvGenreChange() { tvGenre = $('#tv-genre').value; tvPage = 1; loadTv(); }

async function loadTv() {
  $('#tv-list').innerHTML = '<div class="empty">Loading...</div>';
  const r = await api(`/api/tv?genre=${tvGenre}&page=${tvPage}`);
  if (!r.ok || !r.data || !r.data.data || !r.data.data.length) {
    $('#tv-list').innerHTML = '<div class="empty">No channels.</div>';
    $('#tv-pag').innerHTML = '';
    return;
  }
  const d = r.data;
  const total = parseInt(d.total_items || 0);
  const per = Math.max(parseInt(d.max_page_items || 14), 1);
  tvTotalPages = Math.max(1, Math.ceil(total / per));
  $('#tv-title').textContent = `Live TV (${total} channels)`;

  const el = $('#tv-list');
  el.innerHTML = '';
  d.data.forEach(ch => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<div class="ch-num">${esc(String(ch.number || ''))}</div>
      <div class="info"><div class="title">${esc(ch.name || '?')}</div></div>
      <div class="actions"></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-success';
    btn.textContent = '▶ Play';
    btn.onclick = () => playTv(ch.cmd || '', ch.name || 'Channel');
    div.querySelector('.actions').appendChild(btn);
    el.appendChild(div);
  });
  renderPag('#tv-pag', tvPage, tvTotalPages, p => { tvPage = p; loadTv(); });
}

async function playTv(cmd, name) {
  const r = await post('/api/tv_play', {cmd, name});
  if (r.ok && r.player === 'vlc') return;
  if (r.ok && r.player === 'none') alert('VLC not found. Stream URL:\n' + r.url);
  if (!r.ok) alert('Error: ' + (r.error || 'Failed to get stream'));
}

// ---- search ----
async function doSearch() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  $('#search-list').innerHTML = '<div class="empty">Searching...</div>';
  const r = await api(`/api/vod?cat=*&page=1&search=${encodeURIComponent(q)}`);
  if (!r.ok || !r.data || !r.data.data || !r.data.data.length) {
    $('#search-list').innerHTML = '<div class="empty">No results for "' + esc(q) + '"</div>';
    return;
  }
  renderVodList(r.data.data, '#search-list');
}

// ---- downloads ----
function startDlPolling() {
  if (dlPollTimer) return;
  dlPollTimer = setInterval(async () => {
    if (currentPage === 'downloads') await loadDownloads();
    const st = await api('/api/download_status');
    if (!st.ok) return;
    const active = Object.values(st.downloads).filter(d => d.status === 'downloading' || d.status === 'transcoding' || d.status === 'muxing');
    if (active.length === 0) { clearInterval(dlPollTimer); dlPollTimer = null; }
  }, 1500);
}

async function loadDownloads() {
  const el = $('#dl-list');
  let html = '';

  const st = await api('/api/download_status');
  if (st.ok) {
    const entries = Object.entries(st.downloads);
    const active = entries.filter(([,d]) => d.status === 'downloading' || d.status === 'transcoding' || d.status === 'muxing');
    const done = entries.filter(([,d]) => d.status === 'done');
    const errors = entries.filter(([,d]) => d.status.startsWith('error'));

    if (active.length > 0) {
      html += '<div class="dl-section-title">In Progress</div>';
      active.forEach(([id, d]) => {
        const pct = Math.round(d.percent || 0);
        const phase = d.phase || d.status || 'download';
        let phaseLabel = 'Downloading...';
        let barColor = 'var(--accent)';
        if (phase === 'transcoding') {
          phaseLabel = 'Transcoding to H.264 MP4...';
          barColor = 'var(--warn)';
        } else if (phase === 'muxing') {
          phaseLabel = 'Muxing (remuxing streams)...';
          barColor = 'var(--success)';
        }
        const metaParts = [`<span style="color:${barColor};font-weight:600">${esc(phaseLabel)}</span>`];
        if (phase === 'download') metaParts.push(`<span>${pct}%</span>`);
        if (d.speed) metaParts.push('<span>' + esc(d.speed) + '</span>');
        if (d.eta) metaParts.push('<span>' + (phase === 'download' ? 'ETA: ' : '') + esc(d.eta) + '</span>');
        const barWidth = phase === 'transcoding' ? '100' : String(pct);
        const barStyle = phase === 'transcoding'
          ? `background:repeating-linear-gradient(90deg,${barColor} 0%,${barColor} 30%,var(--input) 30%,var(--input) 50%);animation:barPulse 1.5s ease-in-out infinite`
          : `background:${barColor};width:${pct}%`;
        html += `<div class="dl-active">
          <div class="dl-name">${esc(d.name)}</div>
          <div class="dl-bar-bg"><div class="dl-bar" style="${barStyle}"></div></div>
          <div class="dl-meta">${metaParts.join('')}</div>
        </div>`;
      });
    }

    if (errors.length > 0) {
      html += '<div class="dl-section-title">Failed</div>';
      errors.forEach(([id, d]) => {
        html += `<div class="dl-active" style="border-color:var(--err)">
          <div class="dl-name">${esc(d.name)}</div>
          <div class="dl-meta" style="color:var(--err)"><span>${esc(d.status)}</span></div>
        </div>`;
      });
    }
  }

  const r = await api('/api/downloads_list');
  if (r.ok && r.files.length > 0) {
    html += '<div class="dl-section-title">Completed</div>';
    r.files.forEach(f => {
      const div = document.createElement('div');
      html += `<div class="card" data-path="${esc(f.path)}" data-name="${esc(f.name)}">
        <div class="info"><div class="title">${esc(f.name)}</div></div>
        <div class="dl-size">${f.size_mb} MB</div>
        <div class="actions"><button class="btn btn-success" onclick="playFile(this.closest('.card'))">▶ Play</button></div></div>`;
    });
  }

  if (!html) html = '<div class="empty">No downloads yet. Browse VOD and hit Download.</div>';
  el.innerHTML = html;
}

function playFile(card) {
  const p = card.dataset.path;
  const n = card.dataset.name;
  post('/api/play', {url: p, name: n});
}

// ---- settings ----
const STB_MODELS = [
  'AuraHD', 'AuraHD1', 'AuraHD9',
  'MAG 200', 'MAG 245', 'MAG 245D', 'MAG 250', 'MAG 254', 'MAG 254W1', 'MAG 254W2',
  'MAG 255', 'MAG 255W1', 'MAG 255W2', 'MAG 256', 'MAG 260', 'MAG 270', 'MAG 275',
  'MAG 322', 'MAG 324', 'MAG 351', 'MAG 352', 'MAG 420', 'MAG 424', 'MAG 424w3'
];

async function loadSettings() {
  const r = await api('/api/config');
  if (!r.ok) return;
  const c = r.config;
  const form = $('#settings-form');

  let modelOpts = STB_MODELS.map(m => {
    const val = m.replace(/\s+/g, '');
    return `<option value="${val}" ${c.device===val?'selected':''}>${m}</option>`;
  }).join('');


  const req_tag = '<span class="req-tag">REQUIRED</span>';
  form.innerHTML = `
    <div class="section-title">Portal Connection</div>
    <label>Portal URL ${req_tag}</label>
    <div class="hint">Your IPTV provider's portal address. In STB Emu this is just the domain (e.g. <strong>example.com</strong>), but here use the full URL: <strong>http://example.com/stalker_portal</strong></div>
    <input id="set-portal_url" value="${esc(c.portal_url || '')}" placeholder="http://example.com/stalker_portal">

    <label>MAC Address ${req_tag}</label>
    <div class="hint">Your device MAC address (from your provider)</div>
    <input id="set-mac" value="${esc(c.mac || '')}" placeholder="00:1A:79:XX:XX:XX">

    <div class="section-title">STB Configuration</div>
    <div class="hint" style="margin-top:4px;line-height:1.5">These values can be found in your STB Emu app: <strong>Settings → Profile</strong> (select your profile) <strong>→ STB Configuration</strong></div>
    <label>STB Model ${req_tag}</label>
    <div class="hint">Select the set-top box model to emulate</div>
    <select id="set-device">${modelOpts}</select>

    <label>Serial Number</label>
    <div class="hint">Device serial number</div>
    <input id="set-serial" value="${esc(c.serial || '')}">

    <label>Hardware Version</label>
    <div class="hint">Hardware revision (default: 1.7-BD-00)</div>
    <input id="set-hw_version" value="${esc(c.hw_version || '1.7-BD-00')}" placeholder="1.7-BD-00">

    <div class="section-title">Downloads</div>
    <label>Download Folder</label>
    <div class="hint">Where downloaded files are saved</div>
    <div class="folder-row">
      <input id="set-download_dir" value="${esc(c.download_dir || '')}" readonly>
      <button class="btn btn-accent" onclick="pickFolder()">Browse...</button>
      <button class="btn btn-dim" onclick="detectDefault('download_dir')">Auto-detect</button>
    </div>
  `;

  const enc = c.encoder || 'auto';
  const er = await api('/api/encoders');
  let encOpts = `<option value="auto" ${enc==='auto'?'selected':''}>Auto (best available)</option>`;
  if (er.ok && er.hardware && er.hardware.length > 0) {
    er.hardware.forEach(h => {
      encOpts += `<option value="${h.id}" ${enc===h.id?'selected':''}>${esc(h.name)} — ${esc(h.desc)} (${esc(h.platform)})</option>`;
    });
  }
  encOpts += `<option value="software" ${enc==='software'?'selected':''}>Software (libx264) — Slower, universal</option>`;
  const hwList = (er.ok && er.hardware && er.hardware.length > 0) ? er.hardware.map(h => h.name).join(', ') : 'None detected';

  form.innerHTML += `
    <label>H.264 Encoder</label>
    <div class="hint">For .MP4 (H.264) downloads. Detected: <strong>${esc(hwList)}</strong></div>
    <select id="set-encoder">${encOpts}</select>

    <label>VLC Path</label>
    <div class="hint">Path to VLC media player executable</div>
    <div class="folder-row">
      <input id="set-vlc_path" value="${esc(c.vlc_path || '')}" placeholder="Not detected">
      <button class="btn btn-dim" onclick="detectDefault('vlc_path')">Auto-detect</button>
    </div>

    <div class="btns">
      <button class="btn btn-accent" onclick="saveSettings()">Save & Reconnect</button>
      <button class="btn btn-dim" onclick="loadSettings()">Reset</button>
    </div>

    <div class="section-title">Configuration Transfer</div>
    <div class="hint" style="margin-top:4px;line-height:1.5">Export your settings to share with others or back up between devices. Import a previously exported config file to restore settings.</div>
    <div class="config-io">
      <button class="btn btn-accent" onclick="exportConfig()">Export Config</button>
      <button class="btn btn-dim" onclick="document.getElementById('import-file').click()">Import Config</button>
      <input type="file" id="import-file" accept=".json" onchange="importConfig(this)">
    </div>
  `;
}

async function pickFolder() {
  const r = await post('/api/pick_folder', {});
  if (r.ok && r.path) {
    $('#set-download_dir').value = r.path;
  }
}

async function saveSettings() {
  const keys = ['portal_url', 'mac', 'device', 'serial', 'hw_version', 'download_dir',
                'vlc_path', 'encoder'];
  const data = {};
  keys.forEach(k => {
    const el = $(`#set-${k}`);
    if (el) data[k] = el.value;
  });
  let url = (data.portal_url || '').trim();
  if (url && !url.startsWith('http')) url = 'http://' + url;
  if (url && !url.includes('/stalker_portal')) url = url.replace(/\/+$/, '') + '/stalker_portal';
  data.portal_url = url;
  $('#set-portal_url').value = url;
  await post('/api/config', data);
  $('#settings-status').textContent = 'Saved. Reconnecting...';
  $('#settings-status').style.color = 'var(--warn)';
  await connect();
  $('#settings-status').textContent = 'Connected.';
  $('#settings-status').style.color = 'var(--success)';
}

function exportConfig() {
  api('/api/config').then(r => {
    if (!r.ok) return;
    const blob = new Blob([JSON.stringify(r.config, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'streamwarden-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    $('#settings-status').textContent = 'Config exported.';
    $('#settings-status').style.color = 'var(--success)';
  });
}

function importConfig(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const cfg = JSON.parse(e.target.result);
      if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Invalid config');
      const defaults = await post('/api/detect_defaults', {});
      if (defaults.ok) {
        cfg.vlc_path = defaults.vlc_path;
        cfg.download_dir = defaults.download_dir;
      }
      await post('/api/config', cfg);
      $('#settings-status').textContent = 'Config imported. VLC & download path set for this OS. Reconnecting...';
      $('#settings-status').style.color = 'var(--warn)';
      await loadSettings();
      await connect();
      $('#settings-status').textContent = 'Config imported and connected.';
      $('#settings-status').style.color = 'var(--success)';
    } catch (err) {
      $('#settings-status').textContent = 'Import failed: ' + err.message;
      $('#settings-status').style.color = 'var(--err)';
    }
    input.value = '';
  };
  reader.readAsText(file);
}

async function detectDefault(field) {
  const r = await post('/api/detect_defaults', {});
  if (!r.ok) return;
  const val = r[field] || '';
  const el = $(`#set-${field}`);
  if (el) {
    el.value = val;
    $('#settings-status').textContent = val ? `Detected: ${val}` : `Could not auto-detect ${field.replace('_', ' ')}`;
    $('#settings-status').style.color = val ? 'var(--success)' : 'var(--warn)';
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// boot
connect();
loadSettings();
