/**
 * おのざき イベントレジ（オフラインPWA）
 *
 * 電波ゼロの野外イベントでレジを打つための独立アプリ。
 * - アプリ本体は Service Worker がキャッシュ → 圏外でも起動する
 * - 会計データは IndexedDB に保存 → 圏外でも失われない
 * - 電波が戻ったら中継サーバ経由で社内システムへ送信する
 *
 * 送信先URLと合言葉はこのソースには持たせない。端末登録時に「接続コード」
 * として受け取り、その端末のローカルにだけ保存する。
 * したがってこのページを第三者が開いても、接続コードが無ければ何もできない。
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────
  //  IndexedDB
  // ─────────────────────────────────────────────
  var DB_NAME = 'onozaki-event-pos';
  var DB_VER = 1;
  var db = null;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
        if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'eventNo' });
        if (!d.objectStoreNames.contains('txns')) {
          var s = d.createObjectStore('txns', { keyPath: 'clientTxnId' });
          s.createIndex('synced', 'synced');
          s.createIndex('eventNo', 'eventNo');
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function wrap(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function dbGet(store, key) { return wrap(tx(store, 'readonly').get(key)); }
  function dbPut(store, val, key) { return wrap(tx(store, 'readwrite').put(val, key)); }
  function dbAll(store) { return wrap(tx(store, 'readonly').getAll()); }
  function dbDel(store, key) { return wrap(tx(store, 'readwrite').delete(key)); }
  function dbClear(store) { return wrap(tx(store, 'readwrite').clear()); }

  // ─────────────────────────────────────────────
  //  状態
  // ─────────────────────────────────────────────
  var cfg = null;          // { url, secret, deviceName }
  var evt = null;          // 選択中イベント
  var cart = {};           // { 商品index: 個数 }
  var syncing = false;

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
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
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

  function show(screenId) {
    ['s-setup', 's-events', 's-reg', 's-menu'].forEach(function (id) {
      $(id).classList.toggle('active', id === screenId);
    });
    $('pay').style.display = 'none';
    $('btn-menu').style.display = (screenId === 's-setup') ? 'none' : '';
    $('btn-menu').textContent = (screenId === 's-menu') ? '閉じる' : 'メニュー';
  }

  // ─────────────────────────────────────────────
  //  通信（GAS中継）
  // ─────────────────────────────────────────────
  function callGas(action, payload) {
    if (!cfg) return Promise.reject(new Error('端末が未登録です'));
    var body = Object.assign({ secret: cfg.secret, action: action }, payload || {});
    // GASのWeb Appはプリフライトを避けるため text/plain で送る
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

  // ─────────────────────────────────────────────
  //  ネットワーク表示
  // ─────────────────────────────────────────────
  function renderNet() {
    var on = navigator.onLine;
    var c = $('chip-net');
    c.className = 'chip ' + (on ? 'chip-on' : 'chip-off');
    $('chip-net-t').textContent = on ? 'オンライン' : 'オフライン';
  }

  function pendingTxns() {
    return dbAll('txns').then(function (all) {
      return all.filter(function (t) { return !t.synced; });
    });
  }

  function renderPending() {
    return pendingTxns().then(function (p) {
      var c = $('chip-pending');
      if (p.length) {
        c.style.display = '';
        c.textContent = '未送信 ' + p.length + '件';
      } else {
        c.style.display = 'none';
      }
      return p;
    });
  }

  // ─────────────────────────────────────────────
  //  ① 端末セットアップ
  // ─────────────────────────────────────────────
  function applySetupCode(raw) {
    var parsed;
    try {
      parsed = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/\s/g, '')))));
    } catch (e) {
      $('setup-msg').textContent = '接続コードの形式が正しくありません。';
      return;
    }
    if (!parsed.url || !parsed.secret) {
      $('setup-msg').textContent = '接続コードの中身が不足しています。';
      return;
    }
    $('setup-msg').textContent = '確認しています…';
    var tmp = { url: parsed.url, secret: parsed.secret, deviceName: parsed.deviceName || 'iPad' };
    var prev = cfg;
    cfg = tmp;
    callGas('ping', {}).then(function () {
      return dbPut('config', tmp, 'main');
    }).then(function () {
      $('setup-msg').textContent = '';
      toast('この端末を登録しました');
      gotoEvents();
    }).catch(function (err) {
      cfg = prev;
      $('setup-msg').textContent = '登録できませんでした: ' + err.message;
    });
  }

  function initSetup() {
    $('setup-go').onclick = function () {
      var raw = $('setup-code').value.trim();
      if (raw) applySetupCode(raw);
    };
  }

  /**
   * URLの #setup=... で渡された接続コードを拾う。
   * iPadで長い文字列を手入力せずに済むよう、リンクを開くだけで登録できるようにする。
   * 拾ったらすぐURLから消して、履歴や共有に合言葉が残らないようにする。
   */
  function consumeSetupHash() {
    var m = /[#&]setup=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    var code = decodeURIComponent(m[1]);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      location.hash = '';
    }
    return code;
  }

  // ─────────────────────────────────────────────
  //  ② イベント選択・取り込み
  // ─────────────────────────────────────────────
  function gotoEvents() {
    show('s-events');
    $('hdr-title').textContent = 'イベントレジ';
    renderEventList();
  }

  function renderEventList() {
    return dbAll('events').then(function (list) {
      var wrap = $('ev-list');
      if (!list.length) {
        wrap.innerHTML = '<div style="padding:28px;text-align:center;color:#888;font-size:14px;line-height:1.8;">'
          + 'まだイベントが取り込まれていません。<br>電波のあるところで上の「kintoneから取り込む」を押してください。</div>';
        return;
      }
      list.sort(function (a, b) { return (b.startDate || '').localeCompare(a.startDate || ''); });
      wrap.innerHTML = list.map(function (e) {
        var period = e.startDate === e.endDate ? e.startDate : (e.startDate + ' 〜 ' + e.endDate);
        return '<div class="ev-row">'
          + '<div style="flex:1;min-width:0;">'
          + '  <div style="font-weight:bold;color:#1B4F72;font-size:15px;">' + esc(e.eventName) + '</div>'
          + '  <div class="muted">' + esc(period) + '　' + esc(e.accountDept || '') + '　商品' + e.products.length + '件</div>'
          + '</div>'
          + '<button class="btn btn-accent" data-open="' + e.eventNo + '" style="padding:10px 18px;font-size:14px;">レジを開く</button>'
          + '</div>';
      }).join('');
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-open]'), function (b) {
        b.onclick = function () { openRegister(parseInt(b.dataset.open, 10)); };
      });
    });
  }

  function pullEvents() {
    if (!navigator.onLine) { toast('オフラインです。電波のある場所で実行してください', true); return; }
    var btn = $('ev-pull');
    btn.disabled = true; btn.textContent = '取り込み中…';
    callGas('events', {}).then(function (res) {
      // ローカルの累計は取り込み時にサーバー値で上書きする（1台運用が前提）
      var puts = res.events.map(function (e) { return dbPut('events', e); });
      return Promise.all(puts).then(function () { return res.events.length; });
    }).then(function (n) {
      toast(n + '件のイベントを取り込みました');
      renderEventList();
    }).catch(function (err) {
      toast('取り込み失敗: ' + err.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'kintoneから取り込む';
    });
  }

  // ─────────────────────────────────────────────
  //  ③ レジ
  // ─────────────────────────────────────────────
  function openRegister(eventNo) {
    return dbGet('events', eventNo).then(function (e) {
      if (!e) { toast('イベントが見つかりません', true); return; }
      evt = e;
      cart = {};
      dbPut('config', eventNo, 'currentEvent');
      show('s-reg');
      $('hdr-title').textContent = e.eventName;
      renderProducts();
      renderCart();
      renderTotals();
    });
  }

  /** 当日分の商品だけ出す。当日分が無ければ全商品にフォールバック（kintone側レジと同じ挙動）。 */
  function visibleProducts() {
    var today = todayStr();
    var idxs = evt.products.map(function (p, i) { return i; });
    var dated = idxs.filter(function (i) { return evt.products[i].date; });
    var todays = idxs.filter(function (i) {
      var d = evt.products[i].date || '';
      return d === '' || d === today;
    });
    if (dated.length && !todays.some(function (i) { return evt.products[i].date === today; })) return idxs;
    return todays;
  }

  function renderProducts() {
    var grid = $('prod-grid');
    grid.innerHTML = '';
    var vis = visibleProducts();
    if (!vis.length) {
      grid.innerHTML = '<div class="muted" style="padding:20px;">商品が登録されていません。</div>';
      return;
    }
    vis.forEach(function (i) {
      var p = evt.products[i];
      var b = document.createElement('button');
      b.className = 'prod';
      b.innerHTML = '<div class="prod-name">' + esc(p.name)
        + (p.date ? '<span style="font-size:10px;color:#888;font-weight:normal;"> ' + esc(p.date.slice(5)) + '</span>' : '')
        + '</div>'
        + '<div class="prod-price num">' + yen(p.price) + '</div>'
        + '<div class="prod-qty num">累計 ' + (p.actualQty || 0) + '個</div>';
      b.onclick = function () { cart[i] = (cart[i] || 0) + 1; renderCart(); };
      grid.appendChild(b);
    });
  }

  function cartTotal() {
    return Object.keys(cart).reduce(function (s, i) { return s + evt.products[i].price * cart[i]; }, 0);
  }

  function renderCart() {
    var keys = Object.keys(cart).filter(function (i) { return cart[i] > 0; });
    var list = $('cart-list');
    if (!keys.length) {
      list.innerHTML = '<div class="muted" style="text-align:center;padding:18px;">商品をタップしてください</div>';
    } else {
      list.innerHTML = keys.map(function (i) {
        var p = evt.products[i];
        return '<div class="cart-row">'
          + '<span class="cart-name">' + esc(p.name) + '</span>'
          + '<button class="qbtn" data-dec="' + i + '">−</button>'
          + '<span class="num" style="min-width:26px;text-align:center;font-weight:bold;">' + cart[i] + '</span>'
          + '<button class="qbtn" data-inc="' + i + '">+</button>'
          + '<span class="num" style="min-width:70px;text-align:right;">' + yen(p.price * cart[i]) + '</span>'
          + '</div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('[data-inc]'), function (b) {
        b.onclick = function () { cart[b.dataset.inc]++; renderCart(); };
      });
      Array.prototype.forEach.call(list.querySelectorAll('[data-dec]'), function (b) {
        b.onclick = function () {
          var i = b.dataset.dec;
          cart[i]--; if (cart[i] <= 0) delete cart[i];
          renderCart();
        };
      });
    }
    var t = cartTotal();
    $('cart-total').innerHTML = '合計 <span class="num" style="font-size:26px;font-weight:bold;color:#D4573B;">' + yen(t) + '</span>';
    $('pay-cash').disabled = (t <= 0);
    $('pay-paypay').disabled = (t <= 0);
  }

  function todayTarget() {
    var today = todayStr(), t = 0;
    evt.products.forEach(function (p) {
      if (p.date === today) t += p.price * (parseFloat(p.budgetQty) || 0);
    });
    if (t === 0) {
      (evt.dailyBudget || []).forEach(function (d) { if (d.date === today) t += parseFloat(d.target) || 0; });
    }
    return Math.round(t);
  }

  function renderTotals() {
    var achieved = (evt.cash || 0) + (evt.paypay || 0);
    var budget = parseFloat(evt.budgetSales) || 0;
    var tt = todayTarget();
    var ta = evt.todayAchieved && evt.todayAchievedDate === todayStr() ? evt.todayAchieved : 0;
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
      + '<div class="kpi"><div class="kpi-label">現金 累計</div><div class="kpi-value num" style="font-size:16px;">' + yen(evt.cash) + '</div></div>'
      + '<div class="kpi"><div class="kpi-label">PayPay 累計</div><div class="kpi-value num" style="font-size:16px;">' + yen(evt.paypay) + '</div></div>'
      + '</div>'
      + '<div class="kpi" style="margin-top:8px;"><div class="kpi-label">売上 累計</div><div class="kpi-value num" style="color:#D4573B;">' + yen(achieved) + '</div></div>';
    if (tt > 0) {
      var r = ta / tt * 100;
      html += '<div class="card" style="margin-top:8px;border-color:#1B4F72;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:6px;">'
        + '<span style="font-weight:bold;color:#1B4F72;">本日の達成率</span><span class="num">目標 ' + yen(tt) + '</span></div>'
        + '<div class="track"><div class="fill" style="width:' + Math.min(100, r) + '%;' + (r >= 100 ? 'background:linear-gradient(90deg,#1B5E20,#2E8B57);' : '') + '"></div></div>'
        + '<div class="num" style="text-align:right;font-size:22px;font-weight:bold;margin-top:6px;color:' + (r >= 100 ? '#1B5E20' : '#1B4F72') + ';">' + r.toFixed(1) + '%</div>'
        + '</div>';
    }
    if (budget > 0) {
      var br = achieved / budget * 100;
      html += '<div class="card" style="margin-top:8px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:6px;">'
        + '<span style="font-weight:bold;">予算達成率</span><span class="num">予算 ' + yen(budget) + '</span></div>'
        + '<div class="track"><div class="fill" style="width:' + Math.min(100, br) + '%;' + (br >= 100 ? 'background:linear-gradient(90deg,#1B5E20,#2E8B57);' : '') + '"></div></div>'
        + '<div class="num" style="text-align:right;font-size:22px;font-weight:bold;margin-top:6px;color:' + (br >= 100 ? '#1B5E20' : '#1B4F72') + ';">' + br.toFixed(1) + '%'
        + '<span class="muted" style="font-weight:normal;"> （残り ' + yen(Math.max(0, budget - achieved)) + '）</span></div>'
        + '</div>';
    }
    $('reg-totals').innerHTML = html;
  }

  // ─────────────────────────────────────────────
  //  ④ 会計
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
        + '    <button class="btn btn-light" data-back style="padding:10px 20px;">戻る</button>'
        + '  </div>'
        + '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">'
        + '    <div style="display:flex;flex-direction:column;gap:10px;">'
        + '      <div class="kpi"><div class="kpi-label">合計</div><div class="kpi-value num" style="font-size:28px;">' + yen(amt) + '</div></div>'
        + '      <div class="kpi"><div class="kpi-label">お預かり</div><div class="kpi-value num" data-recv style="font-size:26px;">¥0</div></div>'
        + '      <div style="background:#E8F5E9;border:2px solid #1B5E20;border-radius:14px;padding:18px;text-align:center;flex:1;display:flex;flex-direction:column;justify-content:center;">'
        + '        <div style="font-size:13px;color:#1B5E20;font-weight:bold;">お釣り</div>'
        + '        <div class="num" data-change style="font-size:38px;font-weight:bold;color:#1B5E20;">¥0</div>'
        + '      </div>'
        + '    </div>'
        + '    <div id="keypad"></div>'
        + '  </div>'
        + '  <button class="btn btn-primary" data-ok style="width:100%;margin-top:18px;padding:18px;font-size:17px;" disabled>会計確定</button>'
        + '</div>';

      var recvStr = '';
      var recvEl = pay.querySelector('[data-recv]');
      var chEl = pay.querySelector('[data-change]');
      var okBtn = pay.querySelector('[data-ok]');
      function refresh() {
        var recv = parseFloat(recvStr || 0);
        recvEl.textContent = yen(recv);
        var ch = recv - amt;
        if (recvStr !== '' && ch < 0) { chEl.textContent = '不足 ' + yen(-ch); chEl.style.color = '#B8432D'; }
        else { chEl.textContent = yen(ch > 0 ? ch : 0); chEl.style.color = '#1B5E20'; }
        okBtn.disabled = (recv < amt);
        okBtn.textContent = (recv >= amt) ? ('会計確定（お釣り ' + yen(ch) + '）') : '会計確定';
      }
      var kp = pay.querySelector('#keypad');
      ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00', 'C'].forEach(function (k) {
        var b = document.createElement('button');
        b.className = 'btn btn-light';
        if (k === 'C') { b.style.background = '#FDE8E2'; b.style.color = '#B8432D'; b.style.borderColor = '#F3C9BE'; }
        b.textContent = k;
        b.onclick = function () {
          if (k === 'C') recvStr = '';
          else if (recvStr.length < 9) recvStr += k;
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
        + '    <button class="btn btn-light" data-back style="padding:10px 20px;">戻る</button>'
        + '  </div>'
        + '  <div class="card" style="border-color:#D4573B;text-align:center;padding:28px;">'
        + '    <div style="font-size:14px;color:#666;font-weight:bold;">お支払い金額</div>'
        + '    <div class="num" style="font-size:46px;font-weight:bold;color:#D4573B;margin:12px 0;">' + yen(amt) + '</div>'
        + '    <div class="muted" style="margin-bottom:20px;line-height:1.7;">お客様のPayPayでお支払いいただき、完了したら下のボタンを押してください。</div>'
        + '    <button class="btn btn-accent" data-ok style="width:100%;padding:18px;font-size:17px;">決済完了</button>'
        + '  </div>'
        + '</div>';
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

  /** 会計確定。まず端末内に保存し、オンラインなら裏で送信する。 */
  function finalize(method, amt, cashInfo) {
    var items = Object.keys(cart).filter(function (i) { return cart[i] > 0; }).map(function (i) {
      var p = evt.products[i];
      // date も一緒に送る。kintone側で商品明細の行を突き合わせるのに使う
      return { idx: parseInt(i, 10), name: p.name, price: p.price, qty: cart[i], tax: p.tax || '8%', date: p.date || '' };
    });
    var t8 = 0, t10 = 0;
    items.forEach(function (it) {
      var a = it.price * it.qty;
      if (it.tax === '10%') t10 += a; else t8 += a;
    });
    var txn = {
      clientTxnId: uuid(),
      eventNo: evt.eventNo,
      eventName: evt.eventName,
      accountDept: evt.accountDept,
      // kintoneのDATETIMEはミリ秒付きを受け付けないので落とす
      datetime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      method: method,
      total: Math.round(amt),
      items: items.map(function (it) { return { name: it.name, price: it.price, qty: it.qty, tax: it.tax, date: it.date }; }),
      tax8Incl: Math.round(t8),
      tax10Incl: Math.round(t10),
      tax8Vat: Math.round(t8 * 8 / 108),
      tax10Vat: Math.round(t10 * 10 / 110),
      cashReceived: cashInfo ? Math.round(cashInfo.received) : null,
      changeAmount: cashInfo ? Math.round(cashInfo.change) : null,
      synced: 0
    };

    // ローカル累計を更新（1台運用前提）
    items.forEach(function (it) { evt.products[it.idx].actualQty = (evt.products[it.idx].actualQty || 0) + it.qty; });
    if (method === 'cash') evt.cash = (evt.cash || 0) + amt; else evt.paypay = (evt.paypay || 0) + amt;
    if (evt.todayAchievedDate !== todayStr()) { evt.todayAchievedDate = todayStr(); evt.todayAchieved = 0; }
    evt.todayAchieved += amt;

    dbPut('txns', txn).then(function () {
      return dbPut('events', evt);
    }).then(function () {
      cart = {};
      closePay();
      renderProducts(); renderCart(); renderTotals();
      toast((method === 'cash' ? '現金' : 'PayPay') + ' ' + yen(amt) + ' を記録しました');
      renderPending();
      trySync(true);
    }).catch(function (err) {
      // 端末内保存に失敗した場合はローカル累計を巻き戻す
      items.forEach(function (it) { evt.products[it.idx].actualQty -= it.qty; });
      if (method === 'cash') evt.cash -= amt; else evt.paypay -= amt;
      evt.todayAchieved -= amt;
      closePay();
      toast('保存に失敗しました: ' + err.message, true);
    });
  }

  // ─────────────────────────────────────────────
  //  ⑤ 同期
  // ─────────────────────────────────────────────
  function trySync(quiet) {
    if (syncing || !cfg) return Promise.resolve();
    if (!navigator.onLine) {
      if (!quiet) toast('オフラインです。電波が戻ってから送信されます', true);
      return Promise.resolve();
    }
    syncing = true;
    return pendingTxns().then(function (list) {
      if (!list.length) {
        if (!quiet) toast('未送信のデータはありません');
        return;
      }
      // 一度に送りすぎないよう100件ずつ
      var batch = list.slice(0, 100);
      return callGas('sync', { txns: batch }).then(function (res) {
        var okIds = res.accepted || [];
        return Promise.all(okIds.map(function (id) {
          return dbGet('txns', id).then(function (t) {
            if (!t) return;
            t.synced = 1; t.syncedAt = new Date().toISOString();
            return dbPut('txns', t);
          });
        })).then(function () {
          if (!quiet || okIds.length) toast(okIds.length + '件を kintone に送信しました');
          if (res.failed && res.failed.length) toast(res.failed.length + '件が送れませんでした。あとで再送します', true);
        });
      });
    }).catch(function (err) {
      if (!quiet) toast('送信失敗: ' + err.message, true);
    }).then(function () {
      syncing = false;
      renderPending();
      renderMenu();
    });
  }

  // ─────────────────────────────────────────────
  //  ⑥ メニュー
  // ─────────────────────────────────────────────
  function renderMenu() {
    if (!$('s-menu').classList.contains('active')) return;
    dbAll('txns').then(function (all) {
      var pend = all.filter(function (t) { return !t.synced; });
      $('menu-sync-state').innerHTML = pend.length
        ? '<b style="color:#B8432D;">未送信 ' + pend.length + '件</b>（合計 ' + yen(pend.reduce(function (s, t) { return s + t.total; }, 0)) + '）<br>電波のある場所で送信してください。'
        : '<b style="color:#1B5E20;">すべて送信済みです。</b>';

      var today = todayStr();
      var mine = all.filter(function (t) { return t.datetime.slice(0, 10) === today; })
        .sort(function (a, b) { return b.datetime.localeCompare(a.datetime); });
      $('menu-history').innerHTML = mine.length ? mine.map(function (t) {
        var tm = new Date(t.datetime);
        return '<div class="cart-row">'
          + '<span class="num muted" style="min-width:44px;">' + pad2(tm.getHours()) + ':' + pad2(tm.getMinutes()) + '</span>'
          + '<span class="cart-name">' + esc(t.method === 'cash' ? '現金' : 'PayPay') + '</span>'
          + '<span class="num" style="min-width:74px;text-align:right;font-weight:bold;">' + yen(t.total) + '</span>'
          + '<span class="chip ' + (t.synced ? 'chip-on' : 'chip-pending') + '" style="font-size:10px;">' + (t.synced ? '送信済' : '未送信') + '</span>'
          + '</div>';
      }).join('') : '<div class="muted" style="padding:16px;text-align:center;">本日の会計はまだありません。</div>';
    });
    $('menu-device').innerHTML = '接続先: <span style="font-family:monospace;font-size:11px;">' + esc((cfg && cfg.url || '').slice(0, 60)) + '…</span><br>'
      + '端末名: ' + esc(cfg && cfg.deviceName || '-');
  }

  // ─────────────────────────────────────────────
  //  起動
  // ─────────────────────────────────────────────
  function boot() {
    renderNet();
    initSetup();

    $('ev-pull').onclick = pullEvents;
    $('pay-cash').onclick = function () { openPay('cash'); };
    $('pay-paypay').onclick = function () { openPay('paypay'); };
    $('menu-sync').onclick = function () { trySync(false); };
    $('menu-events').onclick = gotoEvents;
    $('menu-reset').onclick = function () {
      pendingTxns().then(function (p) {
        var msg = p.length
          ? '未送信の会計が ' + p.length + '件あります。解除すると送信できなくなります。本当に解除しますか？'
          : '端末登録を解除しますか？（取り込んだイベントと履歴も消えます）';
        if (!confirm(msg)) return;
        Promise.all([dbClear('config'), dbClear('events'), dbClear('txns')]).then(function () {
          cfg = null; evt = null;
          show('s-setup');
        });
      });
    };
    $('btn-menu').onclick = function () {
      if ($('s-menu').classList.contains('active')) {
        show(evt ? 's-reg' : 's-events');
      } else {
        show('s-menu');
        renderMenu();
      }
    };

    window.addEventListener('online', function () { renderNet(); trySync(true); });
    window.addEventListener('offline', renderNet);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { renderNet(); trySync(true); }
    });
    // 5分おきに未送信分の再送を試みる
    setInterval(function () { trySync(true); }, 5 * 60 * 1000);

    var hashCode = consumeSetupHash();

    return openDb().then(function () {
      return Promise.all([dbGet('config', 'main'), dbGet('config', 'currentEvent')]);
    }).then(function (r) {
      cfg = r[0];
      renderPending();
      if (hashCode && !cfg) { show('s-setup'); applySetupCode(hashCode); return; }
      if (!cfg) { show('s-setup'); return; }
      trySync(true);
      if (r[1] != null) {
        return dbGet('events', r[1]).then(function (e) {
          if (e) return openRegister(r[1]);
          gotoEvents();
        });
      }
      gotoEvents();
    }).catch(function (err) {
      toast('起動エラー: ' + err.message, true);
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }
  // 電源が落ちてもデータが消えないよう永続ストレージを要求する
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });

  boot();
})();
