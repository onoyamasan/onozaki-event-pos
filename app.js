/**
 * おのざき イベントレジ（オフラインPWA）
 *
 * 野外イベント用。**通信が要るのは送信のときだけ**。
 * - アプリ本体は Service Worker がキャッシュ → 圏外でも起動する
 * - 商品は端末内のマスタで持つ → 事前の取り込みなしでレジを打てる
 * - 会計は IndexedDB に貯める → 圏外でも消えない
 * - 電波のあるところで、どのイベントの売上かを選んで送信する
 *
 * 送信先URLと合言葉はこのソースには持たせない。端末登録時に「接続コード」として
 * 受け取り、その端末のローカルにだけ保存する。
 * したがってこのページを第三者が開いても、接続コードが無ければ何もできない。
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────
  //  IndexedDB
  // ─────────────────────────────────────────────
  var DB_NAME = 'onozaki-event-pos';
  var DB_VER = 2;
  var db = null;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
        if (!d.objectStoreNames.contains('txns')) {
          var s = d.createObjectStore('txns', { keyPath: 'clientTxnId' });
          s.createIndex('synced', 'synced');
        }
        // v2: 商品マスタを端末に持つようにした。イベントの先読みはやめたので events は捨てる。
        if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'id' });
        if (d.objectStoreNames.contains('events')) d.deleteObjectStore('events');
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function wrap(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function dbGet(store, key) { return wrap(tx(store, 'readonly').get(key)); }
  function dbPut(store, val, key) { return wrap(tx(store, 'readwrite').put(val, key)); }
  function dbAll(store) { return wrap(tx(store, 'readonly').getAll()); }
  function dbDel(store, key) { return wrap(tx(store, 'readwrite').delete(key)); }
  function dbClear(store) { return wrap(tx(store, 'readwrite').clear()); }

  // ─────────────────────────────────────────────
  //  状態
  // ─────────────────────────────────────────────
  var cfg = null;        // { url, secret, deviceName }
  var products = [];     // 端末内の商品マスタ
  var cart = {};         // { 商品id: 個数 }
  var dailyTarget = 0;
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

  var SCREENS = ['s-setup', 's-reg', 's-prod', 's-send', 's-menu'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('active', s === id); });
    $('pay').style.display = 'none';
    $('btn-menu').style.display = (id === 's-setup') ? 'none' : '';
    $('btn-menu').textContent = (id === 's-reg') ? 'メニュー' : 'レジに戻る';
  }

  // ─────────────────────────────────────────────
  //  通信（中継サーバ経由）
  // ─────────────────────────────────────────────
  function callRelay(action, payload) {
    if (!cfg) return Promise.reject(new Error('端末が未登録です'));
    var body = Object.assign({ secret: cfg.secret, action: action }, payload || {});
    // プリフライトを避けるため text/plain で送る
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

  function renderNet() {
    var on = navigator.onLine;
    $('chip-net').className = 'chip ' + (on ? 'chip-on' : 'chip-off');
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
      if (p.length) { c.style.display = ''; c.textContent = '未送信 ' + p.length + '件'; }
      else c.style.display = 'none';
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
    callRelay('ping', {}).then(function () {
      return dbPut('config', tmp, 'main');
    }).then(function () {
      $('setup-msg').textContent = '';
      toast('この端末を登録しました');
      gotoRegister();
    }).catch(function (err) {
      cfg = prev;
      $('setup-msg').textContent = '登録できませんでした: ' + err.message;
    });
  }

  /**
   * URLの #setup=... で渡された接続コードを拾う。
   * QRを読むだけで登録できるようにするため。拾ったらすぐURLから消して、
   * 履歴や共有に合言葉が残らないようにする。
   */
  function consumeSetupHash() {
    var m = /[#&]setup=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    var code = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { location.hash = ''; }
    return code;
  }

  // ─────────────────────────────────────────────
  //  ② 商品マスタ（オフラインで編集できる）
  // ─────────────────────────────────────────────
  function loadProducts() {
    return dbAll('products').then(function (list) {
      list.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
      products = list;
      return products;
    });
  }

  function gotoProducts() {
    show('s-prod');
    $('hdr-title').textContent = '商品の登録';
    renderProdList();
  }

  function renderProdList() {
    var el = $('prod-list');
    if (!products.length) {
      el.innerHTML = '<div class="muted" style="padding:26px;text-align:center;line-height:1.8;">'
        + 'まだ商品がありません。<br>上のフォームから追加してください。</div>';
      return;
    }
    el.innerHTML = products.map(function (p, i) {
      return '<div class="row">'
        + '<button class="qbtn" data-up="' + p.id + '"' + (i === 0 ? ' disabled style="opacity:.3;"' : '') + '>↑</button>'
        + '<div style="flex:1;min-width:0;">'
        + '  <div style="font-weight:bold;color:#1B4F72;">' + esc(p.name) + '</div>'
        + '  <div class="muted num">' + yen(p.price) + '　税率 ' + esc(p.tax) + '</div>'
        + '</div>'
        + '<button class="btn btn-light" data-del="' + p.id + '" style="padding:8px 14px;font-size:13px;color:#B8432D;border-color:#F3C9BE;">削除</button>'
        + '</div>';
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () {
        var p = products.filter(function (x) { return x.id === b.dataset.del; })[0];
        if (!p || !confirm('「' + p.name + '」を削除しますか？\n（送信済み・未送信の会計データはそのまま残ります）')) return;
        dbDel('products', p.id).then(loadProducts).then(function () {
          renderProdList();
          toast('削除しました');
        });
      };
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-up]'), function (b) {
      b.onclick = function () {
        var i = products.findIndex(function (x) { return x.id === b.dataset.up; });
        if (i <= 0) return;
        var a = products[i - 1], c = products[i];
        var s = a.sort; a.sort = c.sort; c.sort = s;
        Promise.all([dbPut('products', a), dbPut('products', c)])
          .then(loadProducts).then(renderProdList);
      };
    });
  }

  function addProduct() {
    var name = $('np-name').value.trim();
    var price = parseFloat($('np-price').value);
    var tax = $('np-tax').value;
    if (!name) { toast('商品名を入れてください', true); return; }
    if (!(price >= 0)) { toast('売価を入れてください', true); return; }
    if (products.some(function (p) { return p.name === name; })) {
      toast('同じ名前の商品がすでにあります', true); return;
    }
    var maxSort = products.reduce(function (m, p) { return Math.max(m, p.sort || 0); }, 0);
    dbPut('products', { id: uuid(), name: name, price: Math.round(price), tax: tax, sort: maxSort + 1 })
      .then(loadProducts).then(function () {
        $('np-name').value = ''; $('np-price').value = '';
        $('np-name').focus();
        renderProdList();
        toast('「' + name + '」を追加しました');
      });
  }

  // ─────────────────────────────────────────────
  //  ③ レジ
  // ─────────────────────────────────────────────
  function gotoRegister() {
    show('s-reg');
    $('hdr-title').textContent = 'おのざき イベントレジ';
    renderProductButtons();
    renderCart();
    renderTotals();
  }

  function renderProductButtons() {
    var grid = $('prod-grid');
    grid.innerHTML = '';
    if (!products.length) {
      grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:30px;">'
        + '<div class="muted" style="line-height:1.8;margin-bottom:14px;">商品がまだ登録されていません。<br>電波が無くてもここで登録できます。</div>'
        + '<button class="btn btn-primary" id="empty-add">商品を登録する</button></div>';
      $('empty-add').onclick = gotoProducts;
      return;
    }
    products.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'prod';
      b.innerHTML = '<div class="prod-name">' + esc(p.name) + '</div>'
        + '<div class="prod-price num">' + yen(p.price) + '</div>';
      b.onclick = function () { cart[p.id] = (cart[p.id] || 0) + 1; renderCart(); };
      grid.appendChild(b);
    });
  }

  function prodById(id) {
    return products.filter(function (p) { return p.id === id; })[0];
  }

  function cartTotal() {
    return Object.keys(cart).reduce(function (s, id) {
      var p = prodById(id);
      return s + (p ? p.price * cart[id] : 0);
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
        return '<div class="cart-row">'
          + '<span class="cart-name">' + esc(p.name) + '</span>'
          + '<button class="qbtn" data-dec="' + id + '">−</button>'
          + '<span class="num" style="min-width:26px;text-align:center;font-weight:bold;">' + cart[id] + '</span>'
          + '<button class="qbtn" data-inc="' + id + '">+</button>'
          + '<span class="num" style="min-width:70px;text-align:right;">' + yen(p.price * cart[id]) + '</span>'
          + '</div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('[data-inc]'), function (b) {
        b.onclick = function () { cart[b.dataset.inc]++; renderCart(); };
      });
      Array.prototype.forEach.call(list.querySelectorAll('[data-dec]'), function (b) {
        b.onclick = function () {
          var id = b.dataset.dec;
          cart[id]--; if (cart[id] <= 0) delete cart[id];
          renderCart();
        };
      });
    }
    var t = cartTotal();
    $('cart-total').innerHTML = '合計 <span class="num" style="font-size:26px;font-weight:bold;color:#D4573B;">' + yen(t) + '</span>';
    $('pay-cash').disabled = (t <= 0);
    $('pay-paypay').disabled = (t <= 0);
  }

  /** 本日ぶんの売上を、端末に残っている会計から数える。 */
  function todayStats() {
    var today = dateStr();
    return dbAll('txns').then(function (all) {
      var mine = all.filter(function (t) { return t.businessDate === today; });
      var cash = 0, paypay = 0, count = 0;
      mine.forEach(function (t) {
        if (t.method === 'cash') cash += t.total; else paypay += t.total;
        count++;
      });
      return { cash: cash, paypay: paypay, total: cash + paypay, count: count };
    });
  }

  function renderTotals() {
    return todayStats().then(function (s) {
      var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
        + '<div class="kpi"><div class="kpi-label">本日 現金</div><div class="kpi-value num" style="font-size:16px;">' + yen(s.cash) + '</div></div>'
        + '<div class="kpi"><div class="kpi-label">本日 PayPay</div><div class="kpi-value num" style="font-size:16px;">' + yen(s.paypay) + '</div></div>'
        + '</div>'
        + '<div class="kpi" style="margin-top:8px;"><div class="kpi-label">本日の売上（' + s.count + '会計）</div>'
        + '<div class="kpi-value num" style="color:#D4573B;">' + yen(s.total) + '</div></div>';
      if (dailyTarget > 0) {
        var r = s.total / dailyTarget * 100;
        html += '<div class="card" style="margin-top:8px;border-color:#1B4F72;">'
          + '<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:6px;">'
          + '<span style="font-weight:bold;color:#1B4F72;">本日の達成率</span><span class="num">目標 ' + yen(dailyTarget) + '</span></div>'
          + '<div class="track"><div class="fill" style="width:' + Math.min(100, r) + '%;' + (r >= 100 ? 'background:linear-gradient(90deg,#1B5E20,#2E8B57);' : '') + '"></div></div>'
          + '<div class="num" style="text-align:right;font-size:22px;font-weight:bold;margin-top:6px;color:' + (r >= 100 ? '#1B5E20' : '#1B4F72') + ';">' + r.toFixed(1) + '%</div>'
          + '</div>';
      }
      $('reg-totals').innerHTML = html;
    });
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

  /** 会計確定。端末内に保存するだけで、通信はしない。 */
  function finalize(method, amt, cashInfo) {
    var items = Object.keys(cart).filter(function (id) { return cart[id] > 0 && prodById(id); })
      .map(function (id) {
        var p = prodById(id);
        return { name: p.name, price: p.price, qty: cart[id], tax: p.tax || '8%' };
      });
    var t8 = 0, t10 = 0;
    items.forEach(function (it) {
      var a = it.price * it.qty;
      if (it.tax === '10%') t10 += a; else t8 += a;
    });
    var now = new Date();
    var txn = {
      clientTxnId: uuid(),
      businessDate: dateStr(now),
      // kintoneのDATETIMEはミリ秒付きを受け付けないので落とす
      datetime: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      method: method,
      total: Math.round(amt),
      items: items,
      tax8Incl: Math.round(t8),
      tax10Incl: Math.round(t10),
      tax8Vat: Math.round(t8 * 8 / 108),
      tax10Vat: Math.round(t10 * 10 / 110),
      cashReceived: cashInfo ? Math.round(cashInfo.received) : null,
      changeAmount: cashInfo ? Math.round(cashInfo.change) : null,
      eventNo: null,      // どのイベントかは送信するときに決める
      synced: 0
    };

    dbPut('txns', txn).then(function () {
      cart = {};
      closePay();
      renderCart();
      renderTotals();
      renderPending();
      toast((method === 'cash' ? '現金' : 'PayPay') + ' ' + yen(amt) + ' を記録しました');
    }).catch(function (err) {
      closePay();
      toast('保存に失敗しました: ' + err.message, true);
    });
  }

  // ─────────────────────────────────────────────
  //  ⑤ 送信（ここだけ通信が要る）
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

      body.innerHTML = '<div class="card" style="text-align:center;padding:24px;">'
        + '<div class="muted">イベント一覧を読み込んでいます…</div></div>';

      return callRelay('events', {}).then(function (res) {
        var events = res.events || [];
        if (!events.length) {
          body.innerHTML = '<div class="card" style="padding:26px;text-align:center;">'
            + '<div style="font-weight:bold;color:#B8432D;margin-bottom:8px;">紐づけ先のイベントがありません</div>'
            + '<div class="muted" style="line-height:1.8;">kintoneの「イベント管理」にイベントを作ってから、もう一度お試しください。</div>'
            + '<button class="btn btn-light" id="send-retry" style="margin-top:16px;">再読み込み</button></div>';
          $('send-retry').onclick = renderSend;
          return;
        }

        // 日付ごとにまとめる（複数日の売上が溜まっていても、日ごとに別のイベントへ送れる）
        var groups = {};
        pend.forEach(function (t) {
          var d = t.businessDate || (t.datetime || '').slice(0, 10);
          (groups[d] = groups[d] || []).push(t);
        });
        var dates = Object.keys(groups).sort();

        var opts = events.map(function (e) {
          var period = e.startDate === e.endDate ? e.startDate : (e.startDate + '〜' + e.endDate);
          return '<option value="' + e.eventNo + '">' + esc(e.eventName) + '（' + esc(period) + '／' + esc(e.accountDept || '') + '）</option>';
        }).join('');

        body.innerHTML = '<div class="muted" style="margin-bottom:14px;line-height:1.8;">'
          + '未送信 <b>' + pend.length + '件</b>（合計 ' + yen(sum) + '）があります。<br>'
          + 'どのイベントの売上として登録するか選んでください。'
          + '</div>'
          + dates.map(function (d) {
            var g = groups[d];
            var gs = g.reduce(function (s, t) { return s + t.total; }, 0);
            // 日付に一番近いイベントを初期選択にしておく
            var best = events.slice().sort(function (a, b) {
              return Math.abs(new Date(a.startDate) - new Date(d)) - Math.abs(new Date(b.startDate) - new Date(d));
            })[0];
            return '<div class="card" style="margin-bottom:12px;">'
              + '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">'
              + '  <div style="font-weight:bold;color:#1B4F72;font-size:16px;">' + esc(d) + '</div>'
              + '  <div class="muted num">' + g.length + '会計 / ' + yen(gs) + '</div>'
              + '</div>'
              + '<select class="field" data-date="' + esc(d) + '">' + opts + '</select>'
              + '<input type="hidden" data-best="' + esc(d) + '" value="' + best.eventNo + '">'
              + '</div>';
          }).join('')
          + '<button class="btn btn-primary" id="send-go" style="width:100%;margin-top:6px;padding:18px;font-size:17px;">この内容で送信する</button>';

        dates.forEach(function (d) {
          var sel = body.querySelector('[data-date="' + d + '"]');
          var best = body.querySelector('[data-best="' + d + '"]');
          if (sel && best) sel.value = best.value;
        });

        $('send-go').onclick = function () {
          var plan = dates.map(function (d) {
            var sel = body.querySelector('[data-date="' + d + '"]');
            var ev = events.filter(function (e) { return String(e.eventNo) === sel.value; })[0];
            return { date: d, txns: groups[d], event: ev };
          });
          doSend(plan);
        };
      }).catch(function (err) {
        // 電波が弱いと navigator.onLine が true のまま通信だけ失敗することがある。
        // その場合も「圏外」と同じ案内にして、現場で不安にさせない。
        if (/Failed to fetch|NetworkError|Load failed|通信エラー/i.test(err.message)) { showOffline(); return; }
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

    var step = plan.reduce(function (chain, g) {
      return chain.then(function () {
        // 送信の直前にイベントを紐づける
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
              t.eventName = g.event.eventName;
              return dbPut('txns', t);
            });
          })).then(function () { okCount += accepted.length; });
        }).catch(function (err) {
          ngCount += g.txns.length;
          if (!firstErr) firstErr = err;
        });
      });
    }, Promise.resolve());

    step.then(function () {
      sending = false;
      renderPending();
      if (okCount) toast(okCount + '件を送信しました');
      if (ngCount) toast(ngCount + '件が送れませんでした: ' + (firstErr ? firstErr.message : ''), true);
      renderSend();
    });
  }

  // ─────────────────────────────────────────────
  //  ⑥ メニュー
  // ─────────────────────────────────────────────
  function gotoMenu() {
    show('s-menu');
    $('hdr-title').textContent = 'メニュー';
    $('daily-target').value = dailyTarget || '';
    $('m-prod-sub').textContent = products.length + '品目 ›';
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
          + '<span class="chip ' + (t.synced ? 'chip-on' : 'chip-pending') + '" style="font-size:10px;">' + (t.synced ? '送信済' : '未送信') + '</span>'
          + '</div>';
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
    $('np-add').onclick = addProduct;
    $('np-price').addEventListener('keydown', function (e) { if (e.key === 'Enter') addProduct(); });
    $('prod-done').onclick = gotoRegister;
    $('reg-edit-prod').onclick = gotoProducts;
    $('pay-cash').onclick = function () { openPay('cash'); };
    $('pay-paypay').onclick = function () { openPay('paypay'); };
    $('m-send').onclick = gotoSend;
    $('m-prod').onclick = gotoProducts;
    $('m-reg').onclick = gotoRegister;
    $('daily-save').onclick = function () {
      dailyTarget = Math.max(0, parseFloat($('daily-target').value) || 0);
      dbPut('config', dailyTarget, 'dailyTarget').then(function () { toast('保存しました'); });
    };
    $('menu-reset').onclick = function () {
      pendingTxns().then(function (p) {
        var msg = p.length
          ? '未送信の会計が ' + p.length + '件あります。解除すると送信できなくなります。本当に解除しますか？'
          : '端末登録を解除しますか？（商品マスタと履歴も消えます）';
        if (!confirm(msg)) return;
        Promise.all([dbClear('config'), dbClear('products'), dbClear('txns')]).then(function () {
          cfg = null; products = []; cart = {}; dailyTarget = 0;
          show('s-setup');
        });
      });
    };
    $('btn-menu').onclick = function () {
      if ($('s-reg').classList.contains('active')) gotoMenu();
      else gotoRegister();
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
      return Promise.all([dbGet('config', 'main'), dbGet('config', 'dailyTarget'), loadProducts()]);
    }).then(function (r) {
      cfg = r[0];
      dailyTarget = r[1] || 0;
      renderPending();
      if (!cfg) {
        show('s-setup');
        if (hashCode) applySetupCode(hashCode);
        return;
      }
      // 商品が1つも無ければ、まず登録してもらう
      if (!products.length) gotoProducts();
      else gotoRegister();
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
