/**
 * おのざき イベントレジ（オフラインPWA）
 *
 * 野外イベント用。**通信が要るのは、取り込みと送信のときだけ**。
 * - アプリ本体は Service Worker がキャッシュ → 圏外でも起動する
 * - 商品はイベントごとに端末内へ持つ → 圏外でもレジを打てる
 * - 電波があるときは kintone からイベント（商品・原価つき）を取り込める
 * - 電波が無いときは、その場でイベントと商品を作って打てる。紐づけは送信時でよい
 *
 * 送信先URLと合言葉はこのソースには持たせない。端末登録時に「接続コード」として
 * 受け取り、その端末のローカルにだけ保存する。
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────
  //  IndexedDB
  // ─────────────────────────────────────────────
  var DB_NAME = 'onozaki-event-pos';
  var DB_VER = 3;
  var db = null;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        var t = e.target.transaction;

        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
        if (!d.objectStoreNames.contains('txns')) {
          var s = d.createObjectStore('txns', { keyPath: 'clientTxnId' });
          s.createIndex('synced', 'synced');
        }
        // v3: 商品をイベントごとに持つようにした
        if (d.objectStoreNames.contains('events')) d.deleteObjectStore('events');
        var ev = d.createObjectStore('events', { keyPath: 'localId' });

        // v2 の共通商品マスタが残っていたら、1つのイベントとして引き継ぐ
        if (d.objectStoreNames.contains('products')) {
          t.objectStore('products').getAll().onsuccess = function (re) {
            var old = re.target.result || [];
            if (old.length) {
              ev.add({
                localId: 'migrated-' + Date.now(),
                eventNo: null, source: 'local',
                name: '引き継いだ商品', accountDept: '',
                startDate: '', endDate: '', budgetSales: 0, manualTarget: 0,
                products: old.map(function (p, i) {
                  return { id: p.id, name: p.name, price: p.price, cost: 0, tax: p.tax, budgetQty: 0, sort: p.sort || i };
                }),
                dailyBudget: [], createdAt: new Date().toISOString()
              });
            }
            d.deleteObjectStore('products');
          };
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function wrap(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function st(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function dbGet(s, k) { return wrap(st(s, 'readonly').get(k)); }
  function dbPut(s, v, k) { return wrap(st(s, 'readwrite').put(v, k)); }
  function dbAll(s) { return wrap(st(s, 'readonly').getAll()); }
  function dbDel(s, k) { return wrap(st(s, 'readwrite').delete(k)); }
  function dbClear(s) { return wrap(st(s, 'readwrite').clear()); }

  // ─────────────────────────────────────────────
  //  状態
  // ─────────────────────────────────────────────
  var cfg = null;
  var events = [];
  var cur = null;      // 選択中のイベント
  var cart = {};
  var sending = false;

  // ─────────────────────────────────────────────
  //  ユーティリティ
  // ─────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function yen(n) { return '¥' + Math.round(n || 0).toLocaleString('ja-JP'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, isErr ? 5000 : 2600);
  }

  var SCREENS = ['s-setup', 's-events', 's-reg', 's-prod', 's-send', 's-menu'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('active', s === id); });
    $('pay').style.display = 'none';
    $('btn-menu').style.display = (id === 's-setup') ? 'none' : '';
    // どの画面からでもメニューに入れるようにする（メニューにいるときだけ戻る）
    $('btn-menu').textContent = (id === 's-menu') ? '戻る' : 'メニュー';
  }

  // ── オーバーレイ
  function overlay(opts) {
    $('ov-head').textContent = opts.title || '';
    var body = $('ov-body');
    body.innerHTML = '';
    if (opts.bodyEl) body.appendChild(opts.bodyEl); else body.innerHTML = opts.bodyHtml || '';
    var ok = $('ov-ok'), cancel = $('ov-cancel');
    ok.style.display = opts.hideOk ? 'none' : '';
    ok.textContent = opts.okLabel || 'OK';
    cancel.textContent = opts.cancelLabel || 'キャンセル';
    ok.onclick = function () { if (opts.onOk) opts.onOk(); };
    cancel.onclick = closeOverlay;
    $('ov').classList.add('open');
  }
  function closeOverlay() { $('ov').classList.remove('open'); $('ov-body').innerHTML = ''; }

  // ─────────────────────────────────────────────
  //  通信
  // ─────────────────────────────────────────────
  function callRelay(action, payload) {
    if (!cfg) return Promise.reject(new Error('端末が未登録です'));
    var body = Object.assign({ secret: cfg.secret, action: action }, payload || {});
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('通信エラー (HTTP ' + r.status + ')');
      return r.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '不明なエラー');
      return j;
    });
  }
  function isNetErr(e) { return /Failed to fetch|NetworkError|Load failed|通信エラー/i.test(e.message || ''); }

  function renderNet() {
    var on = navigator.onLine;
    $('chip-net').className = 'chip ' + (on ? 'chip-on' : 'chip-off');
    $('chip-net-t').textContent = on ? 'オンライン' : 'オフライン';
    $('ev-pull-note').innerHTML = on ? ''
      : 'いまオフラインなので取り込みはできません。<b>「この場で作る」でそのままレジを始められます。</b>';
  }

  function pendingTxns() {
    return dbAll('txns').then(function (a) { return a.filter(function (t) { return !t.synced; }); });
  }
  function renderPending() {
    return pendingTxns().then(function (p) {
      var c = $('chip-pending');
      if (p.length) { c.style.display = ''; c.textContent = '未送信 ' + p.length + '件'; }
      else c.style.display = 'none';
      return p;
    });
  }

  // ─────────────────────────────────────────────
  //  端末セットアップ
  // ─────────────────────────────────────────────
  function applySetupCode(raw) {
    var parsed;
    try { parsed = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/\s/g, ''))))); }
    catch (e) { $('setup-msg').textContent = '接続コードの形式が正しくありません。'; return; }
    if (!parsed.url || !parsed.secret) { $('setup-msg').textContent = '接続コードの中身が不足しています。'; return; }
    $('setup-msg').textContent = '確認しています…';
    var tmp = { url: parsed.url, secret: parsed.secret, deviceName: parsed.deviceName || 'iPad' };
    var prev = cfg;
    cfg = tmp;
    callRelay('ping', {}).then(function () { return dbPut('config', tmp, 'main'); })
      .then(function () { $('setup-msg').textContent = ''; toast('この端末を登録しました'); gotoEvents(); })
      .catch(function (err) { cfg = prev; $('setup-msg').textContent = '登録できませんでした: ' + err.message; });
  }

  function consumeSetupHash() {
    var m = /[#&]setup=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    var code = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { location.hash = ''; }
    return code;
  }

  // ─────────────────────────────────────────────
  //  イベント一覧
  // ─────────────────────────────────────────────
  function loadEvents() {
    return dbAll('events').then(function (list) {
      list.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
      events = list;
      return list;
    });
  }

  function gotoEvents() {
    cur = null;
    show('s-events');
    $('hdr-title').textContent = 'おのざき イベントレジ';
    renderNet();
    renderEventList();
  }

  function renderEventList() {
    return dbAll('txns').then(function (txns) {
      var el = $('ev-list');
      if (!events.length) {
        el.innerHTML = '<div class="muted" style="padding:28px;text-align:center;line-height:1.9;">'
          + 'まだイベントがありません。<br>電波があれば「kintoneから取り込む」、<br>無ければ「この場で作る」で始められます。</div>';
        return;
      }
      el.innerHTML = events.map(function (e) {
        var mine = txns.filter(function (t) { return t.localEventId === e.localId; });
        var pend = mine.filter(function (t) { return !t.synced; }).length;
        var sales = mine.reduce(function (s, t) { return s + t.total; }, 0);
        var period = e.startDate ? (e.startDate === e.endDate ? e.startDate : e.startDate + '〜' + e.endDate) : '日付なし';
        return '<div class="row">'
          + '<button class="pickable" data-open="' + e.localId + '" style="flex:1;min-width:0;padding:0;">'
          + '  <div style="font-weight:bold;color:#1B4F72;font-size:16px;margin-bottom:3px;">' + esc(e.name)
          + '    <span class="tag ' + (e.source === 'kintone' ? 'tag-kintone">kintone' : 'tag-local">この端末') + '</span></div>'
          + '  <div class="muted">' + esc(period) + (e.accountDept ? '　' + esc(e.accountDept) : '')
          + '    　商品' + e.products.length + '件'
          + (mine.length ? '　<b style="color:#D4573B;">売上 ' + yen(sales) + '</b>' : '')
          + (pend ? '　<b style="color:#A85E00;">未送信' + pend + '</b>' : '') + '</div>'
          + '</button>'
          + '<button class="btn btn-light btn-sm" data-del="' + e.localId + '" style="color:#B8432D;border-color:#F3C9BE;">削除</button>'
          + '</div>';
      }).join('');

      Array.prototype.forEach.call(el.querySelectorAll('[data-open]'), function (b) {
        b.onclick = function () { openEvent(b.dataset.open); };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () { deleteEvent(b.dataset.del); };
      });
    });
  }

  function deleteEvent(localId) {
    var e = events.filter(function (x) { return x.localId === localId; })[0];
    if (!e) return;
    dbAll('txns').then(function (txns) {
      var mine = txns.filter(function (t) { return t.localEventId === localId; });
      var pend = mine.filter(function (t) { return !t.synced; });
      if (pend.length) {
        alert('「' + e.name + '」には未送信の会計が ' + pend.length + '件あります。\n送信してから削除してください。');
        return;
      }
      if (!confirm('「' + e.name + '」を端末から削除しますか？\n'
        + (mine.length ? '（送信済みの会計 ' + mine.length + '件の記録も端末から消えます。kintone側は残ります）' : ''))) return;
      Promise.all(mine.map(function (t) { return dbDel('txns', t.clientTxnId); }))
        .then(function () { return dbDel('events', localId); })
        .then(loadEvents).then(renderEventList).then(function () { toast('削除しました'); });
    });
  }

  // ── kintoneから取り込む
  function pullEvents() {
    if (!navigator.onLine) { toast('オフラインです。「この場で作る」で始められます', true); return; }
    var btn = $('ev-pull');
    btn.disabled = true; btn.textContent = '読み込み中…';
    callRelay('events', {}).then(function (res) {
      var list = res.events || [];
      if (!list.length) { toast('kintoneにイベントがありません', true); return; }
      var box = document.createElement('div');
      box.innerHTML = list.map(function (e) {
        var period = e.startDate === e.endDate ? e.startDate : e.startDate + '〜' + e.endDate;
        var already = events.some(function (x) { return x.eventNo === e.eventNo; });
        return '<button class="pickable row" data-no="' + e.eventNo + '" style="width:100%;">'
          + '<div style="flex:1;">'
          + '<div style="font-weight:bold;color:#1B4F72;">' + esc(e.eventName)
          + (already ? ' <span class="tag tag-local">取込済</span>' : '') + '</div>'
          + '<div class="muted">' + esc(period) + '　' + esc(e.accountDept || '') + '</div></div>'
          + '<div style="color:#1B4F72;font-weight:bold;">›</div></button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-no]'), function (b) {
        b.onclick = function () { pullOne(parseInt(b.dataset.no, 10)); };
      });
      overlay({ title: '取り込むイベントを選ぶ', bodyEl: box, hideOk: true, cancelLabel: '閉じる' });
    }).catch(function (err) {
      toast(isNetErr(err) ? '電波が届いていません。「この場で作る」で始められます' : '読み込み失敗: ' + err.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'kintoneから取り込む';
    });
  }

  function pullOne(eventNo) {
    $('ov-head').textContent = '取り込んでいます…';
    $('ov-body').innerHTML = '<div class="muted" style="padding:20px;text-align:center;">しばらくお待ちください</div>';
    callRelay('event', { eventNo: eventNo }).then(function (res) {
      var e = res.event;
      var exist = events.filter(function (x) { return x.eventNo === eventNo; })[0];
      // すでに取り込んでいたら、商品だけ入れ替える（会計データはそのまま）
      var rec = {
        localId: exist ? exist.localId : uuid(),
        eventNo: e.eventNo,
        source: 'kintone',
        name: e.eventName,
        accountDept: e.accountDept,
        startDate: e.startDate,
        endDate: e.endDate,
        budgetSales: e.budgetSales,
        manualTarget: exist ? (exist.manualTarget || 0) : 0,
        products: e.products.map(function (p, i) {
          return { id: uuid(), name: p.name, price: p.price, cost: p.cost, tax: p.tax, budgetQty: p.budgetQty, sort: i };
        }),
        dailyBudget: e.dailyBudget || [],
        createdAt: exist ? exist.createdAt : new Date().toISOString()
      };
      return dbPut('events', rec).then(loadEvents).then(function () {
        closeOverlay();
        toast('「' + e.eventName + '」を取り込みました（商品' + rec.products.length + '件）');
        openEvent(rec.localId);
      });
    }).catch(function (err) {
      closeOverlay();
      toast('取り込み失敗: ' + err.message, true);
    });
  }

  // ── この場で作る
  function newEventDialog() {
    var box = document.createElement('div');
    box.innerHTML = ''
      + '<div class="muted" style="margin-bottom:14px;line-height:1.7;">電波が無くても作れます。'
      + 'kintoneのどのイベントの売上にするかは、<b>あとで送信するときに選べます</b>。</div>'
      + '<div style="margin-bottom:12px;"><div class="muted" style="margin-bottom:5px;">イベント名</div>'
      + '<input id="ne-name" class="field" type="text" placeholder="例）いわき花火大会"></div>'
      + '<div style="margin-bottom:12px;"><div class="muted" style="margin-bottom:5px;">日付</div>'
      + '<input id="ne-date" class="field" type="date" value="' + dateStr() + '"></div>'
      + '<div><div class="muted" style="margin-bottom:5px;">本日の売上目標（任意・入れると達成率が出ます）</div>'
      + '<input id="ne-target" class="field num" type="number" inputmode="numeric" min="0" placeholder="例）50000"></div>';
    overlay({
      title: 'イベントを作る', bodyEl: box, okLabel: '作る',
      onOk: function () {
        var name = $('ne-name').value.trim();
        var date = $('ne-date').value || dateStr();
        var target = parseFloat($('ne-target').value) || 0;
        if (!name) { toast('イベント名を入れてください', true); return; }
        var rec = {
          localId: uuid(), eventNo: null, source: 'local',
          name: name, accountDept: '', startDate: date, endDate: date,
          budgetSales: 0, manualTarget: target,
          products: [], dailyBudget: [], createdAt: new Date().toISOString()
        };
        dbPut('events', rec).then(loadEvents).then(function () {
          closeOverlay();
          cur = rec;
          gotoProducts();     // 商品が無いので、そのまま登録画面へ
        });
      }
    });
    setTimeout(function () { $('ne-name').focus(); }, 100);
  }

  function openEvent(localId) {
    cur = events.filter(function (e) { return e.localId === localId; })[0];
    if (!cur) { gotoEvents(); return; }
    cart = {};
    dbPut('config', localId, 'currentEvent');
    if (!cur.products.length) gotoProducts();
    else gotoRegister();
  }

  // ─────────────────────────────────────────────
  //  商品（イベントごと）
  // ─────────────────────────────────────────────
  function gotoProducts() {
    show('s-prod');
    $('hdr-title').textContent = cur ? cur.name : '商品の登録';
    $('prod-ev').innerHTML = cur
      ? '<b>' + esc(cur.name) + '</b> の商品です。ここで登録した商品がレジに並びます。<br>'
        + '<b>電波が無くても登録できます。</b>'
      : '';
    $('np-copy').style.display = events.some(function (e) { return e.localId !== (cur && cur.localId) && e.products.length; }) ? '' : 'none';
    renderProdList();
  }

  function saveCur() { return dbPut('events', cur).then(loadEvents); }

  function renderProdList() {
    var el = $('prod-list');
    if (!cur || !cur.products.length) {
      el.innerHTML = '<div class="muted" style="padding:26px;text-align:center;line-height:1.8;">'
        + 'まだ商品がありません。<br>上のフォームから追加してください。</div>';
      return;
    }
    cur.products.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    el.innerHTML = cur.products.map(function (p, i) {
      return '<div class="row">'
        + '<button class="qbtn" data-up="' + p.id + '"' + (i === 0 ? ' disabled style="opacity:.3;"' : '') + '>↑</button>'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-weight:bold;color:#1B4F72;">' + esc(p.name) + '</div>'
        + '<div class="muted num">' + yen(p.price) + '　税率 ' + esc(p.tax)
        + (p.cost ? '　原価 ' + yen(p.cost) : '') + '</div></div>'
        + '<button class="btn btn-light btn-sm" data-del="' + p.id + '" style="color:#B8432D;border-color:#F3C9BE;">削除</button>'
        + '</div>';
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () {
        var p = cur.products.filter(function (x) { return x.id === b.dataset.del; })[0];
        if (!p || !confirm('「' + p.name + '」を削除しますか？\n（記録済みの会計はそのまま残ります）')) return;
        cur.products = cur.products.filter(function (x) { return x.id !== p.id; });
        saveCur().then(renderProdList).then(function () { toast('削除しました'); });
      };
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-up]'), function (b) {
      b.onclick = function () {
        var i = cur.products.findIndex(function (x) { return x.id === b.dataset.up; });
        if (i <= 0) return;
        var a = cur.products[i - 1], c = cur.products[i];
        var s = a.sort; a.sort = c.sort; c.sort = s;
        saveCur().then(renderProdList);
      };
    });
  }

  function addProduct() {
    if (!cur) return;
    var name = $('np-name').value.trim();
    var price = parseFloat($('np-price').value);
    var tax = $('np-tax').value;
    if (!name) { toast('商品名を入れてください', true); return; }
    if (!(price >= 0)) { toast('売価を入れてください', true); return; }
    if (cur.products.some(function (p) { return p.name === name; })) {
      toast('同じ名前の商品がすでにあります', true); return;
    }
    var maxSort = cur.products.reduce(function (m, p) { return Math.max(m, p.sort || 0); }, 0);
    cur.products.push({ id: uuid(), name: name, price: Math.round(price), cost: 0, tax: tax, budgetQty: 0, sort: maxSort + 1 });
    saveCur().then(function () {
      $('np-name').value = ''; $('np-price').value = '';
      $('np-name').focus();
      renderProdList();
      toast('「' + name + '」を追加しました');
    });
  }

  function copyProductsDialog() {
    var others = events.filter(function (e) { return e.localId !== cur.localId && e.products.length; });
    if (!others.length) return;
    var box = document.createElement('div');
    box.innerHTML = '<div class="muted" style="margin-bottom:12px;">コピー元のイベントを選んでください。'
      + '同じ名前の商品は追加しません。</div>'
      + others.map(function (e) {
        return '<button class="pickable row" data-src="' + e.localId + '" style="width:100%;">'
          + '<div style="flex:1;"><div style="font-weight:bold;color:#1B4F72;">' + esc(e.name) + '</div>'
          + '<div class="muted">商品' + e.products.length + '件</div></div>'
          + '<div style="color:#1B4F72;font-weight:bold;">›</div></button>';
      }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-src]'), function (b) {
      b.onclick = function () {
        var src = events.filter(function (e) { return e.localId === b.dataset.src; })[0];
        var maxSort = cur.products.reduce(function (m, p) { return Math.max(m, p.sort || 0); }, 0);
        var added = 0;
        src.products.forEach(function (p) {
          if (cur.products.some(function (x) { return x.name === p.name; })) return;
          cur.products.push({ id: uuid(), name: p.name, price: p.price, cost: p.cost, tax: p.tax, budgetQty: 0, sort: ++maxSort });
          added++;
        });
        saveCur().then(function () {
          closeOverlay(); renderProdList();
          toast(added ? (added + '件をコピーしました') : '追加できる商品がありませんでした');
        });
      };
    });
    overlay({ title: '別のイベントから商品をコピー', bodyEl: box, hideOk: true, cancelLabel: '閉じる' });
  }

  // ─────────────────────────────────────────────
  //  レジ
  // ─────────────────────────────────────────────
  function gotoRegister() {
    if (!cur) { gotoEvents(); return; }
    show('s-reg');
    $('hdr-title').textContent = cur.name;
    renderProductButtons();
    renderCart();
    renderTotals();
  }

  /** このイベントで各商品が何個売れたか（端末に残っている会計から） */
  function soldMap() {
    return dbAll('txns').then(function (all) {
      var m = {};
      all.filter(function (t) { return t.localEventId === cur.localId; }).forEach(function (t) {
        (t.items || []).forEach(function (it) { m[it.name] = (m[it.name] || 0) + it.qty; });
      });
      return m;
    });
  }

  function renderProductButtons() {
    var grid = $('prod-grid');
    grid.innerHTML = '';
    if (!cur.products.length) {
      grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:30px;">'
        + '<div class="muted" style="line-height:1.8;margin-bottom:14px;">商品がまだありません。<br>電波が無くてもここで登録できます。</div>'
        + '<button class="btn btn-primary" id="empty-add">商品を登録する</button></div>';
      $('empty-add').onclick = gotoProducts;
      return;
    }
    soldMap().then(function (sold) {
      grid.innerHTML = '';
      cur.products.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'prod';
        b.innerHTML = '<div class="prod-name">' + esc(p.name) + '</div>'
          + '<div class="prod-price num">' + yen(p.price) + '</div>'
          + '<div class="prod-sold num">売れた数 ' + (sold[p.name] || 0) + '</div>';
        b.onclick = function () { cart[p.id] = (cart[p.id] || 0) + 1; renderCart(); };
        grid.appendChild(b);
      });
    });
  }

  function prodById(id) { return cur.products.filter(function (p) { return p.id === id; })[0]; }

  function cartTotal() {
    return Object.keys(cart).reduce(function (s, id) {
      var p = prodById(id); return s + (p ? p.price * cart[id] : 0);
    }, 0);
  }

  function renderCart() {
    var keys = Object.keys(cart).filter(function (id) { return cart[id] > 0 && prodById(id); });
    var list = $('cart-list');
    if (!keys.length) {
      list.innerHTML = '<div class="muted" style="text-align:center;padding:18px;">商品をタップしてください</div>';
    } else {
      list.innerHTML = keys.map(function (id) {
        var p = prodById(id);
        return '<div class="cart-row"><span class="cart-name">' + esc(p.name) + '</span>'
          + '<button class="qbtn" data-dec="' + id + '">−</button>'
          + '<span class="num" style="min-width:26px;text-align:center;font-weight:bold;">' + cart[id] + '</span>'
          + '<button class="qbtn" data-inc="' + id + '">+</button>'
          + '<span class="num" style="min-width:70px;text-align:right;">' + yen(p.price * cart[id]) + '</span></div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('[data-inc]'), function (b) {
        b.onclick = function () { cart[b.dataset.inc]++; renderCart(); };
      });
      Array.prototype.forEach.call(list.querySelectorAll('[data-dec]'), function (b) {
        b.onclick = function () {
          var id = b.dataset.dec; cart[id]--; if (cart[id] <= 0) delete cart[id]; renderCart();
        };
      });
    }
    var t = cartTotal();
    $('cart-total').innerHTML = '合計 <span class="num" style="font-size:26px;font-weight:bold;color:#D4573B;">' + yen(t) + '</span>';
    $('pay-cash').disabled = (t <= 0);
    $('pay-paypay').disabled = (t <= 0);
  }

  /** 本日の目標。kintone由来なら日別目標→商品予算、それも無ければ手入力値。 */
  function todayTarget() {
    var today = dateStr(), t = 0;
    (cur.dailyBudget || []).forEach(function (d) { if (d.date === today) t += d.target || 0; });
    if (!t) {
      cur.products.forEach(function (p) { if (p.budgetQty) t += p.price * p.budgetQty; });
      // 日付をまたぐイベントなら日数で割る
      if (t && cur.startDate && cur.endDate && cur.endDate !== cur.startDate) {
        var days = Math.round((new Date(cur.endDate) - new Date(cur.startDate)) / 86400000) + 1;
        if (days > 1) t = t / days;
      }
    }
    if (!t) t = cur.manualTarget || 0;
    return Math.round(t);
  }

  function renderTotals() {
    var today = dateStr();
    return dbAll('txns').then(function (all) {
      var mine = all.filter(function (t) { return t.localEventId === cur.localId; });
      var td = mine.filter(function (t) { return t.businessDate === today; });
      var cash = 0, paypay = 0;
      td.forEach(function (t) { if (t.method === 'cash') cash += t.total; else paypay += t.total; });
      var todayTotal = cash + paypay;
      var evTotal = mine.reduce(function (s, t) { return s + t.total; }, 0);
      var tt = todayTarget();

      var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
        + '<div class="kpi"><div class="kpi-label">本日 現金</div><div class="kpi-value num" style="font-size:16px;">' + yen(cash) + '</div></div>'
        + '<div class="kpi"><div class="kpi-label">本日 PayPay</div><div class="kpi-value num" style="font-size:16px;">' + yen(paypay) + '</div></div>'
        + '</div>'
        + '<div class="kpi" style="margin-top:8px;"><div class="kpi-label">本日の売上（' + td.length + '会計）</div>'
        + '<div class="kpi-value num" style="color:#D4573B;">' + yen(todayTotal) + '</div></div>';
      if (evTotal !== todayTotal) {
        html += '<div class="kpi" style="margin-top:8px;"><div class="kpi-label">このイベント累計（' + mine.length + '会計）</div>'
          + '<div class="kpi-value num">' + yen(evTotal) + '</div></div>';
      }
      if (tt > 0) {
        var r = todayTotal / tt * 100;
        html += '<div class="card" style="margin-top:8px;border-color:#1B4F72;">'
          + '<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:6px;">'
          + '<span style="font-weight:bold;color:#1B4F72;">本日の達成率</span><span class="num">目標 ' + yen(tt) + '</span></div>'
          + '<div class="track"><div class="fill" style="width:' + Math.min(100, r) + '%;'
          + (r >= 100 ? 'background:linear-gradient(90deg,#1B5E20,#2E8B57);' : '') + '"></div></div>'
          + '<div class="num" style="text-align:right;font-size:22px;font-weight:bold;margin-top:6px;color:'
          + (r >= 100 ? '#1B5E20' : '#1B4F72') + ';">' + r.toFixed(1) + '%</div></div>';
      }
      $('reg-totals').innerHTML = html;
    });
  }

  // ─────────────────────────────────────────────
  //  会計
  // ─────────────────────────────────────────────
  function openPay(method) {
    var amt = cartTotal();
    if (amt <= 0) return;
    var pay = $('pay');
    $('s-reg').classList.remove('active');
    pay.style.display = 'block';

    if (method === 'cash') {
      pay.innerHTML = ''
        + '<div style="max-width:780px;margin:0 auto;">'
        + '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
        + '    <div style="font-size:21px;font-weight:bold;color:#1B4F72;">現金会計</div>'
        + '    <button class="btn btn-light" data-back style="padding:10px 20px;">戻る</button></div>'
        + '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">'
        + '    <div style="display:flex;flex-direction:column;gap:10px;">'
        + '      <div class="kpi"><div class="kpi-label">合計</div><div class="kpi-value num" style="font-size:28px;">' + yen(amt) + '</div></div>'
        + '      <div class="kpi"><div class="kpi-label">お預かり</div><div class="kpi-value num" data-recv style="font-size:26px;">¥0</div></div>'
        + '      <div style="background:#E8F5E9;border:2px solid #1B5E20;border-radius:14px;padding:18px;text-align:center;flex:1;display:flex;flex-direction:column;justify-content:center;">'
        + '        <div style="font-size:13px;color:#1B5E20;font-weight:bold;">お釣り</div>'
        + '        <div class="num" data-change style="font-size:38px;font-weight:bold;color:#1B5E20;">¥0</div></div>'
        + '    </div><div id="keypad"></div></div>'
        + '  <button class="btn btn-primary" data-ok style="width:100%;margin-top:18px;padding:18px;font-size:17px;" disabled>会計確定</button>'
        + '</div>';
      var recvStr = '';
      var recvEl = pay.querySelector('[data-recv]');
      var chEl = pay.querySelector('[data-change]');
      var okBtn = pay.querySelector('[data-ok]');
      var refresh = function () {
        var recv = parseFloat(recvStr || 0);
        recvEl.textContent = yen(recv);
        var ch = recv - amt;
        if (recvStr !== '' && ch < 0) { chEl.textContent = '不足 ' + yen(-ch); chEl.style.color = '#B8432D'; }
        else { chEl.textContent = yen(ch > 0 ? ch : 0); chEl.style.color = '#1B5E20'; }
        okBtn.disabled = (recv < amt);
        okBtn.textContent = (recv >= amt) ? ('会計確定（お釣り ' + yen(ch) + '）') : '会計確定';
      };
      var kp = pay.querySelector('#keypad');
      ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00', 'C'].forEach(function (k) {
        var b = document.createElement('button');
        b.className = 'btn btn-light';
        if (k === 'C') { b.style.background = '#FDE8E2'; b.style.color = '#B8432D'; b.style.borderColor = '#F3C9BE'; }
        b.textContent = k;
        b.onclick = function () {
          if (k === 'C') recvStr = ''; else if (recvStr.length < 9) recvStr += k;
          refresh();
        };
        kp.appendChild(b);
      });
      var ex = document.createElement('button');
      ex.className = 'btn btn-primary';
      ex.style.cssText = 'grid-column:1/-1;padding:16px;font-size:16px;';
      ex.textContent = 'ちょうど（' + yen(amt) + '）';
      ex.onclick = function () { recvStr = String(amt); refresh(); };
      kp.appendChild(ex);
      pay.querySelector('[data-back]').onclick = closePay;
      okBtn.onclick = function () {
        var recv = parseFloat(recvStr || 0);
        if (recv < amt) return;
        okBtn.disabled = true;
        finalize('cash', amt, { received: recv, change: recv - amt });
      };
      refresh();
    } else {
      pay.innerHTML = ''
        + '<div style="max-width:520px;margin:0 auto;">'
        + '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
        + '    <div style="font-size:21px;font-weight:bold;color:#1B4F72;">PayPay会計</div>'
        + '    <button class="btn btn-light" data-back style="padding:10px 20px;">戻る</button></div>'
        + '  <div class="card" style="border-color:#D4573B;text-align:center;padding:28px;">'
        + '    <div style="font-size:14px;color:#666;font-weight:bold;">お支払い金額</div>'
        + '    <div class="num" style="font-size:46px;font-weight:bold;color:#D4573B;margin:12px 0;">' + yen(amt) + '</div>'
        + '    <div class="muted" style="margin-bottom:20px;line-height:1.7;">お客様のPayPayでお支払いいただき、完了したら下のボタンを押してください。</div>'
        + '    <button class="btn btn-accent" data-ok style="width:100%;padding:18px;font-size:17px;">決済完了</button>'
        + '  </div></div>';
      pay.querySelector('[data-back]').onclick = closePay;
      pay.querySelector('[data-ok]').onclick = function () {
        pay.querySelector('[data-ok]').disabled = true;
        finalize('paypay', amt, null);
      };
    }
  }

  function closePay() {
    $('pay').style.display = 'none';
    $('pay').innerHTML = '';
    $('s-reg').classList.add('active');
  }

  /** 会計確定。端末内に保存するだけで、通信はしない。 */
  function finalize(method, amt, cashInfo) {
    var items = Object.keys(cart).filter(function (id) { return cart[id] > 0 && prodById(id); })
      .map(function (id) {
        var p = prodById(id);
        return { name: p.name, price: p.price, qty: cart[id], tax: p.tax || '8%', date: '' };
      });
    var t8 = 0, t10 = 0;
    items.forEach(function (it) {
      var a = it.price * it.qty;
      if (it.tax === '10%') t10 += a; else t8 += a;
    });
    var now = new Date();
    var txn = {
      clientTxnId: uuid(),
      localEventId: cur.localId,
      eventNo: cur.eventNo || null,   // kintone由来なら決まっている
      businessDate: dateStr(now),
      datetime: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),   // kintoneはミリ秒を受け付けない
      method: method,
      total: Math.round(amt),
      items: items,
      tax8Incl: Math.round(t8),
      tax10Incl: Math.round(t10),
      tax8Vat: Math.round(t8 * 8 / 108),
      tax10Vat: Math.round(t10 * 10 / 110),
      cashReceived: cashInfo ? Math.round(cashInfo.received) : null,
      changeAmount: cashInfo ? Math.round(cashInfo.change) : null,
      synced: 0
    };
    dbPut('txns', txn).then(function () {
      cart = {};
      closePay();
      renderProductButtons(); renderCart(); renderTotals(); renderPending();
      toast((method === 'cash' ? '現金' : 'PayPay') + ' ' + yen(amt) + ' を記録しました');
    }).catch(function (err) {
      closePay();
      toast('保存に失敗しました: ' + err.message, true);
    });
  }

  // ─────────────────────────────────────────────
  //  送信
  // ─────────────────────────────────────────────
  function gotoSend() {
    show('s-send');
    $('hdr-title').textContent = 'kintone に送信';
    renderSend();
  }

  function renderSend() {
    var body = $('send-body');
    return pendingTxns().then(function (pend) {
      if (!pend.length) {
        body.innerHTML = '<div class="card" style="text-align:center;padding:34px;">'
          + '<div style="font-size:17px;font-weight:bold;color:#1B5E20;margin-bottom:8px;">すべて送信済みです</div>'
          + '<div class="muted">未送信の会計はありません。</div></div>';
        return;
      }
      var sum = pend.reduce(function (s, t) { return s + t.total; }, 0);
      var showOffline = function () {
        body.innerHTML = '<div class="card" style="text-align:center;padding:30px;">'
          + '<div style="font-size:17px;font-weight:bold;color:#B8432D;margin-bottom:10px;">まだ電波が届いていません</div>'
          + '<div class="muted" style="line-height:1.8;">未送信 <b>' + pend.length + '件</b>（' + yen(sum) + '）を預かっています。<br>'
          + '<b>データは消えません。</b>電波のあるところで、もう一度この画面を開いてください。</div>'
          + '<button class="btn btn-light" id="send-retry" style="margin-top:16px;">もう一度試す</button></div>';
        $('send-retry').onclick = renderSend;
      };
      if (!navigator.onLine) { showOffline(); return; }

      body.innerHTML = '<div class="card" style="text-align:center;padding:24px;"><div class="muted">イベント一覧を読み込んでいます…</div></div>';

      return callRelay('events', {}).then(function (res) {
        var list = res.events || [];
        if (!list.length) {
          body.innerHTML = '<div class="card" style="padding:26px;text-align:center;">'
            + '<div style="font-weight:bold;color:#B8432D;margin-bottom:8px;">紐づけ先のイベントがありません</div>'
            + '<div class="muted" style="line-height:1.8;">kintoneの「イベント管理」にイベントを作ってから、もう一度お試しください。</div>'
            + '<button class="btn btn-light" id="send-retry" style="margin-top:16px;">再読み込み</button></div>';
          $('send-retry').onclick = renderSend;
          return;
        }

        // 端末のイベントごとにまとめる（イベント不明の古いデータは日付でまとめる）
        var groups = {};
        pend.forEach(function (t) {
          var k = t.localEventId || ('date:' + (t.businessDate || (t.datetime || '').slice(0, 10)));
          (groups[k] = groups[k] || []).push(t);
        });

        var opts = list.map(function (e) {
          var period = e.startDate === e.endDate ? e.startDate : e.startDate + '〜' + e.endDate;
          return '<option value="' + e.eventNo + '">' + esc(e.eventName) + '（' + esc(period) + '／' + esc(e.accountDept || '') + '）</option>';
        }).join('');

        var keys = Object.keys(groups);
        body.innerHTML = '<div class="muted" style="margin-bottom:14px;line-height:1.8;">'
          + '未送信 <b>' + pend.length + '件</b>（合計 ' + yen(sum) + '）があります。<br>'
          + 'どのイベントの売上として登録するか確認してください。</div>'
          + keys.map(function (k, i) {
            var g = groups[k];
            var gs = g.reduce(function (s, t) { return s + t.total; }, 0);
            var ev = events.filter(function (e) { return e.localId === k; })[0];
            var label = ev ? ev.name : (k.replace('date:', '') + ' の売上');
            var dates = g.map(function (t) { return t.businessDate; })
              .filter(function (v, idx, a) { return a.indexOf(v) === idx; }).sort().join('・');
            // kintone由来ならその番号、そうでなければ日付が一番近いイベントを既定にする
            var pre = (ev && ev.eventNo) ? ev.eventNo : (function () {
              var d = g[0].businessDate || dateStr();
              return list.slice().sort(function (a, b) {
                return Math.abs(new Date(a.startDate) - new Date(d)) - Math.abs(new Date(b.startDate) - new Date(d));
              })[0].eventNo;
            })();
            return '<div class="card" style="margin-bottom:12px;">'
              + '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">'
              + '<div style="font-weight:bold;color:#1B4F72;font-size:16px;">' + esc(label) + '</div>'
              + '<div class="muted num">' + g.length + '会計 / ' + yen(gs) + '</div></div>'
              + '<div class="muted" style="margin-bottom:10px;">' + esc(dates) + '</div>'
              + '<select class="field" data-g="' + i + '">' + opts + '</select>'
              + '<input type="hidden" data-pre="' + i + '" value="' + pre + '">'
              + '</div>';
          }).join('')
          + '<button class="btn btn-primary" id="send-go" style="width:100%;margin-top:6px;padding:18px;font-size:17px;">この内容で送信する</button>';

        keys.forEach(function (k, i) {
          var sel = body.querySelector('[data-g="' + i + '"]');
          var pre = body.querySelector('[data-pre="' + i + '"]');
          if (sel && pre) sel.value = pre.value;
        });

        $('send-go').onclick = function () {
          var plan = keys.map(function (k, i) {
            var sel = body.querySelector('[data-g="' + i + '"]');
            return {
              txns: groups[k],
              event: list.filter(function (e) { return String(e.eventNo) === sel.value; })[0]
            };
          });
          doSend(plan);
        };
      }).catch(function (err) {
        if (isNetErr(err)) { showOffline(); return; }
        body.innerHTML = '<div class="card" style="padding:26px;text-align:center;">'
          + '<div style="font-weight:bold;color:#B8432D;margin-bottom:8px;">読み込みに失敗しました</div>'
          + '<div class="muted" style="line-height:1.8;">' + esc(err.message) + '<br><b>データは端末に残っています。</b></div>'
          + '<button class="btn btn-light" id="send-retry" style="margin-top:16px;">もう一度</button></div>';
        $('send-retry').onclick = renderSend;
      });
    });
  }

  function doSend(plan) {
    if (sending) return;
    sending = true;
    var btn = $('send-go');
    if (btn) { btn.disabled = true; btn.textContent = '送信中…'; }
    var okCount = 0, ngCount = 0, firstErr = null;

    plan.reduce(function (chain, g) {
      return chain.then(function () {
        var txns = g.txns.map(function (t) {
          return Object.assign({}, t, {
            eventNo: g.event.eventNo,
            eventName: g.event.eventName,
            accountDept: g.event.accountDept
          });
        });
        return callRelay('sync', { txns: txns }).then(function (res) {
          var accepted = res.accepted || [];
          return Promise.all(accepted.map(function (id) {
            return dbGet('txns', id).then(function (t) {
              if (!t) return;
              t.synced = 1;
              t.syncedAt = new Date().toISOString();
              t.eventNo = g.event.eventNo;
              return dbPut('txns', t);
            });
          })).then(function () { okCount += accepted.length; });
        }).catch(function (err) {
          ngCount += g.txns.length;
          if (!firstErr) firstErr = err;
        });
      });
    }, Promise.resolve()).then(function () {
      sending = false;
      renderPending();
      if (okCount) toast(okCount + '件を送信しました');
      if (ngCount) toast(ngCount + '件が送れませんでした: ' + (firstErr ? firstErr.message : ''), true);
      renderSend();
    });
  }

  // ─────────────────────────────────────────────
  //  メニュー
  // ─────────────────────────────────────────────
  function gotoMenu() {
    show('s-menu');
    $('hdr-title').textContent = 'メニュー';
    $('m-events-sub').textContent = events.length + '件 ›';
    $('m-prod-sub').textContent = cur ? (cur.products.length + '品目 ›') : '－';
    $('m-prod').disabled = !cur;
    $('m-reg').style.display = cur ? '' : 'none';

    dbAll('txns').then(function (all) {
      var pend = all.filter(function (t) { return !t.synced; });
      $('m-send-sub').textContent = pend.length ? ('未送信 ' + pend.length + '件 ›') : 'すべて送信済み ›';
      var today = dateStr();
      var mine = all.filter(function (t) { return t.businessDate === today; })
        .sort(function (a, b) { return (b.datetime || '').localeCompare(a.datetime || ''); });
      $('menu-history').innerHTML = mine.length ? mine.map(function (t) {
        var tm = new Date(t.datetime);
        return '<div class="cart-row">'
          + '<span class="num muted" style="min-width:44px;">' + pad2(tm.getHours()) + ':' + pad2(tm.getMinutes()) + '</span>'
          + '<span class="cart-name">' + (t.method === 'cash' ? '現金' : 'PayPay') + '</span>'
          + '<span class="num" style="min-width:74px;text-align:right;font-weight:bold;">' + yen(t.total) + '</span>'
          + '<span class="chip ' + (t.synced ? 'chip-on' : 'chip-pending') + '" style="font-size:10px;">'
          + (t.synced ? '送信済' : '未送信') + '</span></div>';
      }).join('') : '<div class="muted" style="padding:16px;text-align:center;">本日の会計はまだありません。</div>';
    });
    $('menu-device').innerHTML = '接続先: <span style="font-family:monospace;font-size:11px;">'
      + esc((cfg && cfg.url || '').slice(0, 52)) + '…</span><br>端末名: ' + esc(cfg && cfg.deviceName || '-');
  }

  // ─────────────────────────────────────────────
  //  起動
  // ─────────────────────────────────────────────
  function boot() {
    renderNet();

    $('setup-go').onclick = function () {
      var raw = $('setup-code').value.trim();
      if (raw) applySetupCode(raw);
    };
    $('ev-pull').onclick = pullEvents;
    $('ev-new').onclick = newEventDialog;
    $('np-add').onclick = addProduct;
    $('np-price').addEventListener('keydown', function (e) { if (e.key === 'Enter') addProduct(); });
    $('np-copy').onclick = copyProductsDialog;
    $('prod-done').onclick = function () { cur && cur.products.length ? gotoRegister() : gotoEvents(); };
    $('reg-edit-prod').onclick = gotoProducts;
    $('pay-cash').onclick = function () { openPay('cash'); };
    $('pay-paypay').onclick = function () { openPay('paypay'); };
    $('m-send').onclick = gotoSend;
    $('m-events').onclick = gotoEvents;
    $('m-prod').onclick = function () { if (cur) gotoProducts(); };
    $('m-reg').onclick = function () { if (cur) gotoRegister(); };
    $('menu-reset').onclick = function () {
      pendingTxns().then(function (p) {
        var msg = p.length
          ? '未送信の会計が ' + p.length + '件あります。解除すると送信できなくなります。本当に解除しますか？'
          : '端末登録を解除しますか？（イベント・商品・履歴も消えます）';
        if (!confirm(msg)) return;
        Promise.all([dbClear('config'), dbClear('events'), dbClear('txns')]).then(function () {
          cfg = null; events = []; cur = null; cart = {};
          show('s-setup');
        });
      });
    };
    $('btn-menu').onclick = function () {
      if ($('s-menu').classList.contains('active')) { if (cur) gotoRegister(); else gotoEvents(); }
      else gotoMenu();
    };

    window.addEventListener('online', renderNet);
    window.addEventListener('offline', renderNet);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        renderNet();
        if ($('s-send').classList.contains('active')) renderSend();
      }
    });

    var hashCode = consumeSetupHash();

    return openDb().then(function () {
      return Promise.all([dbGet('config', 'main'), dbGet('config', 'currentEvent'), loadEvents()]);
    }).then(function (r) {
      cfg = r[0];
      renderPending();
      if (!cfg) {
        show('s-setup');
        if (hashCode) applySetupCode(hashCode);
        return;
      }
      var last = events.filter(function (e) { return e.localId === r[1]; })[0];
      if (last) { cur = last; gotoRegister(); }
      else gotoEvents();
    }).catch(function (err) {
      toast('起動エラー: ' + err.message, true);
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });

  boot();
})();
