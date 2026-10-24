
'use strict';

var IslandUpdate = (function(){
  var EXPECT_KEY = 'island.update.expect';
  var LAST_CHECK_KEY = 'island.update.lastCheck';
  var MAX_TRIES = 2;
  var _busy = false, _remote = null;

  function localBuild(){ return typeof ISLAND_BUILD === 'string' ? ISLAND_BUILD : ''; }
  function localVersion(){ return typeof ISLAND_VERSION === 'string' ? ISLAND_VERSION : ''; }

  function isNativeApp(){
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return true;
    } catch(e) {}
    return location.hostname === 'localhost' && location.protocol === 'https:';
  }

  function lsGet(key){ try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch(e){ return null; } }
  function lsSet(key, val){ try { localStorage.setItem(key, JSON.stringify(val)); } catch(e){} }
  function lsDel(key){ try { localStorage.removeItem(key); } catch(e){} }

  function withTimeout(promise, ms, msg){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ reject(new Error(msg || '超时')); }, ms);
      promise.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
    });
  }

  function fetchRemote(){
    return withTimeout(
      fetch('./version.json?_=' + Date.now(), { cache:'no-store' }).then(function(resp){
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      }),
      12000, '连接超时'
    ).then(function(info){
      if (!info || typeof info.build !== 'string') throw new Error('版本信息格式不对');
      return info;
    });
  }

  function check(){
    var local = { version:localVersion(), build:localBuild() };
    return fetchRemote().then(function(remote){
      _remote = remote;
      lsSet(LAST_CHECK_KEY, { at:Date.now(), build:remote.build });
      return { state: remote.build === local.build ? 'latest' : 'available', local:local, remote:remote };
    }).catch(function(err){
      return { state:'error', local:local, remote:null, error:err };
    });
  }

  function assetUrlsFromHtml(html){
    var urls = {};
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch(e){ return []; }
    doc.querySelectorAll('script[src], link[rel~="stylesheet"][href], link[rel="manifest"][href], link[rel~="icon"][href], link[rel="apple-touch-icon"][href]').forEach(function(el){
      var raw = el.getAttribute('src') || el.getAttribute('href') || '';
      if (!raw || /^(https?:)?\/\//i.test(raw) || raw.indexOf('data:') === 0) return;
      try { urls[new URL(raw, location.href).href] = 1; } catch(e){}
    });
    return Object.keys(urls);
  }

  function reloadAssets(onProgress){
    var base = new URL('./', location.href).href;
    return fetch(base + 'index.html', { cache:'reload' }).then(function(resp){
      if (!resp.ok) throw new Error('index.html 下载失败（HTTP ' + resp.status + '）');
      return resp.text();
    }).then(function(html){
      var list = assetUrlsFromHtml(html);
      ['sw.js', 'manifest.webmanifest', 'changelog.json'].forEach(function(n){ list.push(base + n); });
      fetch(base, { cache:'reload' }).catch(function(){});
      var done = 0, total = list.length, queue = list.slice(), failed = [];
      function worker(){
        var url = queue.shift();
        if (!url) return Promise.resolve();
        return fetch(url, { cache:'reload' }).then(function(r){
          if (!r.ok) failed.push(url);
          return r.arrayBuffer();
        }).catch(function(){ failed.push(url); }).then(function(){
          done++; if (onProgress) onProgress(done, total);
          return worker();
        });
      }
      var workers = []; for (var i = 0; i < 6; i++) workers.push(worker());
      return Promise.all(workers).then(function(){
        if (failed.length) throw new Error('有 ' + failed.length + ' 个文件没下载下来，请检查网络后重试');
        return total;
      });
    });
  }

  function clearShellCaches(){
    if (!window.caches) return Promise.resolve();
    return caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k.indexOf('island-') === 0; }).map(function(k){ return caches.delete(k); }));
    }).catch(function(){});
  }

  function unregisterWorkers(){
    if (!(navigator.serviceWorker && navigator.serviceWorker.getRegistrations)) return Promise.resolve();
    return navigator.serviceWorker.getRegistrations().then(function(regs){
      return Promise.all(regs.map(function(r){ return r.unregister(); }));
    }).catch(function(){});
  }

  function protectData(){
    var flush = (typeof flushSafetyState === 'function') ? flushSafetyState() : Promise.resolve(true);
    return withTimeout(Promise.resolve(flush), 8000, '保存超时').then(function(){
      return IslandDB.snapshot('pre-update').catch(function(){ return false; });
    }).then(function(){ return true; }).catch(function(err){
      console.warn('[岛屿] 更新前保存数据出错：', err);
      return islandConfirm('更新前保存本地数据时出了问题：\n' + (err && err.message ? err.message : '未知错误') + '\n\n建议先到「设置 › 数据与储存」导出一份完整备份。仍要继续更新吗？', {
        title:'数据保存提醒', confirmText:'仍要更新', cancelText:'先不更新', danger:true
      });
    });
  }

  function reloadSoon(deep){
    if (deep) {

      var u = new URL(location.href);
      u.searchParams.set('_u', String(Date.now()));
      location.replace(u.href);
    } else {
      location.reload();
    }
  }

  function apply(target, deep, setStatus){
    if (_busy) return Promise.resolve(false);
    _busy = true;
    setStatus = setStatus || function(){};
    var tries = 0;
    var prev = lsGet(EXPECT_KEY);
    if (prev && prev.build === target) tries = prev.tries || 0;

    setStatus('正在保存本地数据…');
    return protectData().then(function(ok){
      if (!ok) { setStatus(''); _busy = false; return false; }
      if (IslandDB && IslandDB.requestPersistent) IslandDB.requestPersistent();
      setStatus('正在下载新版文件…');
      return reloadAssets(function(done, total){ setStatus('正在下载新版文件 ' + done + '/' + total); }).then(function(){
        setStatus('正在清理旧缓存…');
        return clearShellCaches();
      }).then(function(){
        return deep ? unregisterWorkers() : (navigator.serviceWorker && navigator.serviceWorker.getRegistration ? navigator.serviceWorker.getRegistration().then(function(r){ return r && r.update(); }).catch(function(){}) : null);
      }).then(function(){
        lsSet(EXPECT_KEY, { build:target || '', tries:tries + 1, at:Date.now() });
        setStatus('即将刷新…');

        setTimeout(function(){ reloadSoon(!!deep); }, 350);
        return true;
      });
    }).catch(function(err){
      _busy = false;
      setStatus('');
      throw err;
    });
  }

  function stripCacheParam(){
    try {
      var u = new URL(location.href);
      if (u.searchParams.has('_u')) {
        u.searchParams.delete('_u');
        history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
      }
    } catch(e){}
  }

  function verifyAfterReload(){
    stripCacheParam();
    var expect = lsGet(EXPECT_KEY);
    if (!expect) return;
    var fresh = expect.at && (Date.now() - expect.at) < 30 * 60 * 1000;
    if (!fresh) { lsDel(EXPECT_KEY); return; }
    if (!expect.build || expect.build === localBuild()) {
      lsDel(EXPECT_KEY);
      toast('已更新到最新版 ' + localVersion());
      return;
    }

    if ((expect.tries || 0) >= MAX_TRIES + 1) {
      lsDel(EXPECT_KEY);
      islandConfirm('已经强制刷新了多次，页面仍是旧版本。\n\n你的本地数据都还在，没有受影响。可以试试：\n1. 完全关闭岛屿（含后台）后重新打开；\n2. 在浏览器设置里清除"缓存的图片和文件"（注意不要勾选 Cookie 和网站数据）；\n3. 稍等一两分钟，等线上部署完成后再检查更新。', {
        title:'更新还没有生效', confirmText:'知道了', cancelText:'关闭'
      });
      return;
    }
    islandConfirm('新版本已经下载，但页面还没有完全换成新版（当前 ' + (localBuild() || '未知') + '，目标 ' + expect.build + '）。\n\n需要再强制刷新一次。你的本地数据不会受影响。', {
      title:'需要再强制刷新', confirmText:'再次强制刷新', cancelText:'稍后'
    }).then(function(ok){
      if (!ok) return;
      apply(expect.build, true, function(t){ if (t) toast(t); }).catch(function(err){ toast('刷新失败：' + (err && err.message ? err.message : err)); });
    });
  }

  function fmtBuild(){ return localVersion() ? ('v' + localVersion()) : '未知版本'; }

  function fmtInfo(info){
    if (!info) return '';
    var v = info.version ? 'v' + info.version : '';
    if (info.version === localVersion() || !v) v += (v ? ' ' : '') + '构建 ' + String(info.build || '').split('-').pop();
    return v;
  }

  function setRowStatus(text, hot){
    var el = document.getElementById('updateRowStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-hot', !!hot);
  }
  function setCard(text, kind){
    var el = document.getElementById('updateCardMsg');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  }
  function setBusyUi(on, text){
    ['updateCardCheck', 'updateCardForce', 'checkUpdateRow'].forEach(function(id){
      var b = document.getElementById(id); if (b) b.disabled = !!on;
    });
    if (text !== undefined) setCard(text, on ? 'busy' : '');
  }

  function refreshDataInfo(){
    var el = document.getElementById('updateCardData');
    if (!el) return;
    var parts = ['更新只换程序文件，不会清除聊天、人设、设置等本地数据'];
    Promise.all([IslandDB.requestPersistent(), IslandDB.snapshotInfo()]).then(function(r){
      var persisted = r[0], snaps = r[1];
      if (persisted === true) parts.push('持久化存储：已开启（浏览器不会在空间紧张时自动清理）');
      else if (persisted === false) parts.push('持久化存储：浏览器暂未授予，建议定期在「数据与储存」导出备份');
      var times = Object.keys(snaps).map(function(k){ return snaps[k].savedAt; }).filter(Boolean);
      if (times.length) parts.push('最近一次整库安全快照：' + new Date(Math.max.apply(null, times)).toLocaleString());
      el.textContent = parts.join('\n');
    }).catch(function(){ el.textContent = parts.join('\n'); });
  }

  function renderStatic(){
    var native = isNativeApp();
    var ver = document.getElementById('updateCardVersion');
    if (ver) ver.textContent = '当前版本 ' + fmtBuild() + (localBuild() ? '（构建 ' + localBuild().split('-').pop() + '）' : '');
    var card = document.getElementById('updateCard');
    if (card) card.dataset.native = native ? '1' : '0';
    var nativeNote = document.getElementById('updateCardNative');
    if (nativeNote) nativeNote.hidden = !native;
    ['updateCardCheck', 'updateCardForce'].forEach(function(id){ var b = document.getElementById(id); if (b) b.hidden = native; });
    setRowStatus(fmtBuild(), false);
    refreshDataInfo();
  }

  function announceAvailable(res){
    setRowStatus('有新版本', true);
    setCard('发现新版本 ' + fmtInfo(res.remote) + '，点「立即更新」即可。', 'hot');
  }

  function runCheck(opts){
    opts = opts || {};
    if (isNativeApp()) {
      return islandConfirm('安卓 APK 是覆盖安装更新：下载新版安装包直接安装即可，聊天、人设、设置等本地数据会保留，不需要卸载。\n\n请保持使用同一个签名的安装包（同一个仓库打出来的 APK）。', {
        title:'APK 更新说明', confirmText:'知道了', cancelText:'关闭'
      });
    }
    if (_busy) return Promise.resolve();
    setBusyUi(true, '正在检查更新…');
    setRowStatus('检查中…', false);
    return check().then(function(res){
      setBusyUi(false);
      if (res.state === 'error') {
        setRowStatus(fmtBuild(), false);
        setCard('检查失败：' + (res.error && res.error.message ? res.error.message : '无法连接') + '。请检查网络后重试。', 'error');
        toast('检查更新失败，请检查网络');
        return;
      }
      if (res.state === 'latest') {
        setRowStatus('已是最新', false);
        setCard('已是最新版本 ' + fmtBuild() + '。', 'ok');
        toast('已是最新版本');
        return;
      }
      announceAvailable(res);
      return islandConfirm('发现新版本 ' + fmtInfo(res.remote) + '（当前 ' + fmtInfo({ version:localVersion(), build:localBuild() }) + '）。\n\n更新只会刷新程序文件，不会清除你的聊天、人设和设置等本地数据。刷新前会先保存并留一份安全快照。', {
        title:'发现新版本', confirmText:'立即更新', cancelText:'稍后'
      }).then(function(ok){ if (ok) return doApply(res.remote.build, false); });
    });
  }

  function doApply(target, deep){
    setBusyUi(true, '准备更新…');
    return apply(target, deep, function(t){ setCard(t, 'busy'); }).then(function(started){
      if (!started) setBusyUi(false, '');
    }).catch(function(err){
      setBusyUi(false);
      setCard('更新失败：' + (err && err.message ? err.message : err) + '。当前版本和数据都没有变化。', 'error');
      toast('更新失败，已保留当前版本');
    });
  }

  function runForce(){
    if (isNativeApp()) return runCheck();
    if (_busy) return Promise.resolve();
    return islandConfirm('将重新下载全部程序文件并刷新页面。\n\n不会清除聊天、人设、设置等本地数据。', {
      title:'强制刷新', confirmText:'强制刷新', cancelText:'取消'
    }).then(function(ok){
      if (!ok) return;
      var target = (_remote && _remote.build) || localBuild();

      return check().then(function(res){
        if (res.state !== 'error') target = res.remote.build;
        return doApply(target, true);
      });
    });
  }

  function bind(){
    renderStatic();
    var row = document.getElementById('checkUpdateRow');
    if (row) row.addEventListener('click', function(){ runCheck(); });
    var b1 = document.getElementById('updateCardCheck');
    if (b1) b1.addEventListener('click', function(){ runCheck(); });
    var b2 = document.getElementById('updateCardForce');
    if (b2) b2.addEventListener('click', function(){ runForce(); });
    var open = document.getElementById('openIslandAbout');
    if (open) open.addEventListener('click', function(){ renderStatic(); });
    stripCacheParam();

    setTimeout(verifyAfterReload, 3800);

    if (!isNativeApp()) {
      setTimeout(function(){
        var last = lsGet(LAST_CHECK_KEY);
        if (last && Date.now() - last.at < 30 * 60 * 1000 && last.build === localBuild()) return;
        check().then(function(res){ if (res.state === 'available') announceAvailable(res); });
      }, 6000);
    }
  }

  return { check:check, apply:apply, bind:bind, isNativeApp:isNativeApp, runCheck:runCheck, runForce:runForce };
})();
