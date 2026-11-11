(function () {
  'use strict';

  var CFG = window.PORTAL_CONFIG || {};
  var API = CFG.api || '';
  var EMAIL_RE = /^[\w\-.]+@([\w\-]+\.)+[\w\-]{2,}$/;
  var FONT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
  var CAP_A = 'M20 6 L38 15 L20 24 L2 15 Z';
  var CAP_B = 'M9 20 V27 Q20 33 31 27 V20 L20 25 Z';
  var CAP_C = 'M36 16 V27';
  var $ = function (id) { return document.getElementById(id); };

  var MAX_PICKUPS = 3;
  var PHOTO_MAX_SIDE = 800;          // same size the app uses
  var PHOTO_MAX_CHARS = 440000;      // the Worker refuses anything bigger

  var registered = {};      // children registered in this visit (blocks same name + phone twice)
  var submitting = false;   // blocks double taps
  var card = null;          // the card currently shown
  var requestId = newRequestId();   // same ID on a retry, so a dropped network never creates a second child
  var pickups = [];         // authorized pickup persons being typed in the form
  var pickupSeq = 0;

  /* ---------- which organization is this link for? The secret token (?t=...) decides, the server checks it ---------- */
  var TOKEN_RE = /^[a-z][a-z0-9]{19}$/;
  var TOKEN = '';
  try { TOKEN = String(new URLSearchParams(window.location.search).get('t') || '').trim().toLowerCase(); } catch (e) {}
  var org = { name: '', label: 'Organization' };

  /* ---------- classroom: School = dropdown, Church / other = manual input (same rule as the app) ---------- */
  // Keep this list identical to _schoolClasses in child_registration_screen.dart and SCHOOL_CLASSES in PortalRegister.gs
  var SCHOOL_CLASSES = [
    'Day care', 'Creche', 'Pre-nursery',
    'Nursery 1', 'Nursery 2', 'Nursery 3',
    'Primary 1', 'Primary 2', 'Primary 3', 'Primary 4', 'Primary 5', 'Primary 6',
    'JSS 1', 'JSS 2', 'JSS 3',
    'SS 1', 'SS 2', 'SS 3'
  ];

  function isSchool() { return org.label === 'School'; }

  function setupClassroom() {
    var sel = $('classroomSelect'), txt = $('classroom');
    if (isSchool()) {
      if (sel.options.length <= 1) {
        SCHOOL_CLASSES.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c;
          o.textContent = c;
          sel.appendChild(o);
        });
      }
      sel.classList.remove('hidden');
      txt.classList.add('hidden');
    } else {
      sel.classList.add('hidden');
      txt.classList.remove('hidden');
    }
  }

  // The class chosen / typed for the current organization type
  function classroomValue() { return isSchool() ? $('classroomSelect').value : val('classroom'); }

  /* ---------- date limits: not in the future, not more than 25 years ago ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  var today = new Date();
  var MAX_DOB = iso(today);
  var MIN_DOB = iso(new Date(today.getFullYear() - 25, today.getMonth(), today.getDate()));
  $('dob').min = MIN_DOB;
  $('dob').max = MAX_DOB;

  function calcAge(dobIso) {
    var p = dobIso.split('-');
    var y = +p[0], m = +p[1], d = +p[2];
    var age = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
    return age < 0 ? 0 : age;
  }

  /* ---------- helpers ---------- */
  function newRequestId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var s = '';
    for (var i = 0; i < 32; i++) {
      var r = (window.crypto && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint8Array(1))[0] % 16
        : Math.floor(Math.random() * 16);
      s += r.toString(16);
    }
    return s;
  }

  function showError(msg) {
    var e = $('error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function clearError() { $('error').classList.add('hidden'); }
  function showMsg(msg) { $('msg').textContent = msg || ''; }

  function setStep(n) {
    $('gate').classList.add('hidden');
    [1, 2].forEach(function (i) { $('step' + i).classList.toggle('hidden', i !== n); });
    var items = document.querySelectorAll('#steps li');
    for (var i = 0; i < items.length; i++) {
      var num = i + 1;
      items[i].classList.toggle('is-current', num === n && n !== 2);
      items[i].classList.toggle('is-done', num < n || n === 2);
    }
    clearError();
    var h = $('h' + n);
    if (h) h.focus();
    window.scrollTo(0, 0);
  }

  function setBusy(btn, on) {
    if (on) {
      btn.disabled = true;
      btn.textContent = 'Please wait…';
    } else {
      btn.textContent = btn.getAttribute('data-label');
      btn.disabled = false;
    }
  }

  function call(payload) {
    if (!API || API.indexOf('YOUR-') !== -1) {
      return Promise.reject(new Error('This page is not set up yet. Ask the admin to finish the setup.'));
    }
    // text/plain keeps this a "simple" request, so the browser skips the extra preflight round trip.
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        try { return JSON.parse(t); }
        catch (e) { throw new Error('The server sent an unexpected reply. Please try again in a few minutes.'); }
      });
  }

  function fmtDate(isoStr) {
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function phoneKey(p) {
    var c = String(p || '').replace(/\D/g, '');
    if (c.charAt(0) === '0' && c.length > 1) c = c.slice(1);
    return c;
  }
  function dupKey(name, phone) { return String(name || '').trim().toLowerCase() + '|' + phoneKey(phone); }

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /* ---------- form behaviour ---------- */
  $('dob').addEventListener('change', function () {
    var v = $('dob').value;
    if (v && v >= MIN_DOB && v <= MAX_DOB) $('age').value = calcAge(v);
  });

  $('toggleAnswer').addEventListener('click', function () {
    var inp = $('securityAnswer');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
    this.setAttribute('aria-pressed', show ? 'true' : 'false');
  });

  function val(id) { return $(id).value.trim(); }

  /* ---------- authorized pickup persons ---------- */
  function pickupBlank(e) {
    return !e.name.value.trim() && !e.phone.value.trim() && !e.photo;
  }

  function updatePickupUi() {
    for (var i = 0; i < pickups.length; i++) {
      pickups[i].title.textContent = 'Pickup person ' + (i + 1);
    }
    var btn = $('addPickup');
    btn.textContent = 'Add pickup person (' + pickups.length + '/' + MAX_PICKUPS + ')';
    btn.classList.toggle('hidden', pickups.length >= MAX_PICKUPS);
  }

  // Reads the chosen picture, shrinks it (max 800 px, JPEG) and gives back a data: URL
  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//i.test(file.type || '')) { reject(new Error('Please choose a photo.')); return; }
      if (file.size > 20 * 1024 * 1024) { reject(new Error('That photo is too large. Please choose a smaller one.')); return; }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('Could not read that photo. Please try another one.')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not read that photo. Please try another one.')); };
        img.onload = function () {
          var scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          var q = [0.7, 0.5, 0.35];
          for (var i = 0; i < q.length; i++) {
            var url = c.toDataURL('image/jpeg', q[i]);
            if (url.length - url.indexOf(',') - 1 <= PHOTO_MAX_CHARS) { resolve(url); return; }
          }
          reject(new Error('That photo is too large. Please choose a smaller one.'));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function addPickup() {
    if (pickups.length >= MAX_PICKUPS) return;
    var n = ++pickupSeq;

    var box = make('div', 'pcard');
    var head = make('div', 'phead');
    var title = make('span', 'ptitle');
    var rm = make('button', 'textbtn', 'Remove');
    rm.type = 'button';
    head.appendChild(title);
    head.appendChild(rm);
    box.appendChild(head);

    var body = make('div', 'pbody');

    var photoBtn = make('button', 'pphoto');
    photoBtn.type = 'button';
    photoBtn.setAttribute('aria-label', 'Add photo of this pickup person (required)');
    var photoTxt = make('span', '', 'Add photo *');
    var photoImg = make('img', 'hidden');
    photoImg.alt = 'Photo of the pickup person';
    photoBtn.appendChild(photoTxt);
    photoBtn.appendChild(photoImg);

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = 'hidden';
    file.setAttribute('aria-hidden', 'true');
    file.tabIndex = -1;

    var fields = make('div', 'pfields');
    var nameLbl = make('label', '', 'Full name *');
    nameLbl.setAttribute('for', 'pn' + n);
    var name = document.createElement('input');
    name.id = 'pn' + n;
    name.type = 'text';
    name.autocomplete = 'off';
    name.setAttribute('autocapitalize', 'words');
    name.maxLength = 80;
    var phoneLbl = make('label', '', 'Phone (if available)');
    phoneLbl.setAttribute('for', 'pp' + n);
    var phone = document.createElement('input');
    phone.id = 'pp' + n;
    phone.type = 'tel';
    phone.setAttribute('inputmode', 'tel');
    phone.autocomplete = 'off';
    phone.maxLength = 20;
    fields.appendChild(nameLbl);
    fields.appendChild(name);
    fields.appendChild(phoneLbl);
    fields.appendChild(phone);

    body.appendChild(photoBtn);
    body.appendChild(fields);
    box.appendChild(body);
    box.appendChild(file);

    var entry = { box: box, title: title, name: name, phone: phone, photo: '', photoBtn: photoBtn, photoImg: photoImg, photoTxt: photoTxt };

    photoBtn.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      clearError();
      photoTxt.textContent = 'Please wait…';
      readPhoto(f).then(function (url) {
        entry.photo = url;
        photoImg.src = url;
        photoImg.classList.remove('hidden');
        photoTxt.classList.add('hidden');
        photoBtn.classList.add('has-photo');
      }).catch(function (e) {
        photoTxt.textContent = entry.photo ? '' : 'Add photo *';
        showError((e && e.message) || 'Could not use that photo.');
      });
    });
    rm.addEventListener('click', function () {
      var i = pickups.indexOf(entry);
      if (i !== -1) pickups.splice(i, 1);
      box.remove();
      updatePickupUi();
    });

    pickups.push(entry);
    $('pickups').appendChild(box);
    updatePickupUi();
    name.focus();
  }

  $('addPickup').addEventListener('click', addPickup);

  // Same rules as the app: name (3+ letters) and photo needed, phone optional (10-13 digits)
  function checkPickups() {
    var n = 0;
    for (var i = 0; i < pickups.length; i++) {
      var p = pickups[i];
      if (pickupBlank(p)) continue;
      n++;
      var lbl = 'Pickup person ' + n + ': ';
      if (p.name.value.trim().length < 3) return [p.name, lbl + 'enter the full name.'];
      if (!p.photo) return [p.photoBtn, lbl + 'add a photo.'];
      var ph = p.phone.value.trim();
      if (ph) {
        var digits = ph.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 13) return [p.phone, lbl + 'phone number is not valid (or leave it blank).'];
      }
    }
    return null;
  }

  function pickupPayload() {
    var out = [];
    pickups.forEach(function (p) {
      if (pickupBlank(p)) return;
      out.push({
        name: p.name.value.trim(),
        phone: p.phone.value.trim(),
        photoBase64: p.photo.split(',')[1] || ''
      });
    });
    return out;
  }

  function check() {
    if (!val('childName')) return ['childName', 'Child name is required.'];
    var dob = $('dob').value;
    if (!dob) return ['dob', "Please select the child's date of birth."];
    if (dob < MIN_DOB || dob > MAX_DOB) return ['dob', 'Please check the date of birth.'];
    var age = parseInt($('age').value, 10);
    if (isNaN(age) || age < 0 || age > 30) return ['age', 'Enter a valid age.'];
    if (!classroomValue()) return [isSchool() ? 'classroomSelect' : 'classroom', 'Classroom is required.'];
    if (!val('parentName')) return ['parentName', 'Parent name is required.'];
    if (val('parentPhone').replace(/\D/g, '').length < 10) return ['parentPhone', 'Enter a valid phone number.'];
    var em = val('parentEmail');
    if (em && !EMAIL_RE.test(em)) return ['parentEmail', 'Please enter a valid email address.'];
    var pk = checkPickups();
    if (pk) return [pk[0], pk[1]];
    if (!val('securityQuestion')) return ['securityQuestion', 'Security question is required.'];
    if (!$('securityAnswer').value.trim()) return ['securityAnswer', 'Security answer is required.'];
    return null;
  }

  $('form1').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (submitting) return;
    clearError();

    var problem = check();
    if (problem) {
      showError(problem[1]);
      var target = (typeof problem[0] === 'string') ? $(problem[0]) : problem[0];
      if (target && target.focus) target.focus();
      return;
    }

    // same name + same parent phone as a child already registered in this visit
    var key = dupKey(val('childName'), val('parentPhone'));
    if (registered[key]) {
      showError('A child with this name and parent phone already exists!');
      return;
    }

    var payload = {
      action: 'register',
      token: TOKEN,
      requestId: requestId,
      childName: val('childName'),
      dateOfBirth: $('dob').value,
      age: parseInt($('age').value, 10),
      classroom: classroomValue(),
      parentName: val('parentName'),
      parentPhone: val('parentPhone'),
      parentEmail: val('parentEmail'),
      pickups: pickupPayload(),
      securityQuestion: val('securityQuestion'),
      securityAnswer: $('securityAnswer').value.trim()
    };

    var btn = $('btn1');
    submitting = true;
    setBusy(btn, true);
    call(payload)
      .then(function (res) {
        if (!res.success) { showError(res.error || 'Failed to register child.'); return; }

        card = {
          childId: res.childId || '',
          childName: res.childName || payload.childName,
          classroom: res.classroom || payload.classroom,
          orgId: res.orgId || '',
          orgName: res.orgName || org.name || '',
          orgLabel: res.orgLabel || org.label || 'Organization',
          registeredAt: res.registeredAt || new Date().toISOString(),
          qrImage: res.qrImage || '',
          qrCodeUrl: res.qrCodeUrl || '',
          pickupSaved: Array.isArray(res.pickupSaved) ? res.pickupSaved : [],
          pickupFailed: Array.isArray(res.pickupFailed) ? res.pickupFailed : []
        };
        registered[key] = true;
        requestId = newRequestId();      // the next child gets a fresh ID
        $('securityAnswer').value = '';
        renderCard();
        setStep(2);
      })
      .catch(function (e) { showError(e.message || 'Network problem. Check your internet and try again.'); })
      .then(function () { submitting = false; setBusy(btn, false); });
  });

  /* ---------- the registration card (on screen) ---------- */
  function renderCard() {
    var label = card.orgLabel || 'Organization';
    $('regDate').textContent = card.registeredAt ? 'Registered: ' + fmtDate(card.registeredAt) : '';
    $('cardOrg').textContent = label.toUpperCase();
    $('kOrgName').textContent = label;
    $('vOrgName').textContent = card.orgName || '';
    $('kOrg').textContent = label + ' ID';
    $('vId').textContent = card.childId;
    $('vName').textContent = card.childName;
    $('vClass').textContent = card.classroom;
    $('vOrg').textContent = card.orgId;
    $('qrId').textContent = card.childId;

    if (card.pickupSaved.length) {
      $('vPickup').textContent = card.pickupSaved.join(', ');
      $('pickupRow').classList.remove('hidden');
    } else {
      $('vPickup').textContent = '';
      $('pickupRow').classList.add('hidden');
    }
    var warn = $('pickupWarn');
    if (card.pickupFailed.length) {
      warn.textContent = 'Your child is registered, but ' + card.pickupFailed.length +
        ' pickup person' + (card.pickupFailed.length === 1 ? ' was' : 's were') +
        ' not saved (' + card.pickupFailed.join('; ') + '). Please ask your children\'s department admin to add ' +
        (card.pickupFailed.length === 1 ? 'this person.' : 'them.');
      warn.classList.remove('hidden');
    } else {
      warn.textContent = '';
      warn.classList.add('hidden');
    }

    var img = $('qrImg'), ph = $('qrPh'), link = $('qrLink');
    link.textContent = '';
    if (card.qrImage) {
      img.src = card.qrImage;
      img.classList.remove('hidden');
      ph.classList.add('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
      ph.classList.remove('hidden');
      if (card.qrCodeUrl && /^https:\/\//i.test(card.qrCodeUrl)) {
        var a = document.createElement('a');
        a.href = card.qrCodeUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = "Open your child's QR code";
        link.appendChild(a);
      }
    }
    $('shareQr').classList.toggle('hidden', !card.qrImage);
    showMsg('');
  }

  /* ---------- the registration card (as a picture to download or share) ---------- */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function setLS(ctx, v) { if ('letterSpacing' in ctx) ctx.letterSpacing = v; }

  function wrapText(ctx, text, maxW) {
    var words = String(text || '').split(/\s+/);
    var lines = [], line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; }
      else line = t;
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function cardCanvas() {
    var S = 3, M = 16, W = 420, CW = W - 2 * M;
    var label = card.orgLabel || 'Organization';
    var rows = [['Child ID', card.childId], ['Name', card.childName], ['Classroom', card.classroom]];
    if (card.orgName) rows.push([label, card.orgName]);
    rows.push([label + ' ID', card.orgId]);
    if (card.pickupSaved.length) rows.push(['Pickup persons', card.pickupSaved.join(', ')]);

    var m = document.createElement('canvas').getContext('2d');
    m.font = '600 15px ' + FONT;
    var valueX = 132, valueW = CW - valueX - 20;
    var laid = rows.map(function (r) { return { k: r[0], lines: wrapText(m, r[1], valueW) }; });

    var headH = 150, y = headH + 20;
    laid.forEach(function (r, i) {
      r.y = y;
      y += r.lines.length * 20 + 8;
      if (i < laid.length - 1) { r.divY = y + 12; y += 24; }
    });
    var infoEnd = y + 20;
    var qrTop = infoEnd + 20;
    var idY = qrTop + 224 + 12 + 18;
    var capY = idY + 4 + 14;
    var cardH = capY + 20;

    var c = document.createElement('canvas');
    c.width = W * S;
    c.height = (cardH + 2 * M) * S;
    var ctx = c.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#f4f5fa';
    ctx.fillRect(0, 0, W, cardH + 2 * M);
    ctx.translate(M, M);

    rr(ctx, 0, 0, CW, cardH, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.save();
    rr(ctx, 0, 0, CW, cardH, 16);
    ctx.clip();

    // header
    ctx.fillStyle = '#1a237e';
    ctx.fillRect(0, 0, CW, headH);
    ctx.save();
    ctx.translate(CW / 2 - 20, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fill(new Path2D(CAP_A));
    ctx.fill(new Path2D(CAP_B));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke(new Path2D(CAP_C));
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 28px ' + FONT;
    setLS(ctx, '2px');
    ctx.fillText(label.toUpperCase(), CW / 2, 100);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '400 13px ' + FONT;
    setLS(ctx, '1.2px');
    ctx.fillText('CHILD REGISTRATION CARD', CW / 2, 126);
    setLS(ctx, '0px');

    // details
    ctx.textAlign = 'left';
    laid.forEach(function (r) {
      ctx.fillStyle = '#586079';
      ctx.font = '500 13px ' + FONT;
      ctx.fillText(r.k, 20, r.y + 16);
      ctx.fillStyle = '#12162b';
      ctx.font = '600 15px ' + FONT;
      r.lines.forEach(function (line, i) { ctx.fillText(line, valueX, r.y + 16 + i * 20); });
      if (r.divY) { ctx.fillStyle = '#d8dbe9'; ctx.fillRect(20, r.divY, CW - 40, 1); }
    });

    // QR section
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, infoEnd, CW, cardH - infoEnd);
    var bx = CW / 2 - 112;
    rr(ctx, bx, qrTop, 224, 224, 12);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#d8dbe9';
    ctx.lineWidth = 1;
    ctx.stroke();
    var img = $('qrImg');
    if (card.qrImage && img.complete && img.naturalWidth) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, bx + 12, qrTop + 12, 200, 200);
    } else {
      ctx.fillStyle = '#e8eaf0';
      ctx.fillRect(bx + 12, qrTop + 12, 200, 200);
      ctx.fillStyle = '#8a90a6';
      ctx.textAlign = 'center';
      ctx.font = '400 14px ' + FONT;
      ctx.fillText('QR code unavailable', CW / 2, qrTop + 116);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#12162b';
    ctx.font = '700 18px ' + FONT;
    setLS(ctx, '2px');
    ctx.fillText(card.childId, CW / 2, idY);
    setLS(ctx, '0px');
    ctx.fillStyle = '#586079';
    ctx.font = 'italic 400 12px ' + FONT;
    ctx.fillText('Scan for quick check-in/out', CW / 2, capY);
    ctx.restore();

    rr(ctx, 0, 0, CW, cardH, 16);
    ctx.strokeStyle = '#d8dbe9';
    ctx.lineWidth = 1;
    ctx.stroke();
    return c;
  }

  function qrCanvas() {
    var c = document.createElement('canvas');
    c.width = c.height = 1024;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage($('qrImg'), 64, 64, 896, 896);
    return c;
  }

  function canvasBlob(c) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not create the picture.')); }, 'image/png');
    });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  // Opens the phone's share sheet when it can share a picture, otherwise saves the picture
  function shareOrSave(blob, name, title, text) {
    var file = null;
    try { file = new File([blob], name, { type: 'image/png' }); } catch (e) {}
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title, text: text }).then(function () { return 'shared'; });
    }
    saveBlob(blob, name);
    return Promise.resolve('saved');
  }

  function shareText() {
    var l = card.orgLabel || 'Organization';
    return (card.orgName ? card.orgName + ' - ' : '') + 'Child Registration Card\n\n' +
      'Child: ' + card.childName + '\n' +
      'ID: ' + card.childId + '\n' +
      l + ' ID: ' + card.orgId + '\n' +
      'Classroom: ' + card.classroom + '\n' +
      (card.pickupSaved.length ? 'Pickup persons: ' + card.pickupSaved.join(', ') + '\n' : '') +
      '\nScan the QR code for quick check-in/check-out.';
  }

  function withBusy(btn, busyLabel, fn) {
    btn.disabled = true;
    btn.textContent = busyLabel;
    showMsg('');
    return fn()
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;      // the person closed the share sheet
        showMsg((e && e.message) ? e.message : 'Something went wrong. Please try again.');
      })
      .then(function () {
        btn.textContent = btn.getAttribute('data-label');
        btn.disabled = false;
      });
  }

  $('dl').addEventListener('click', function () {
    if (!card) return;
    var name = 'ChildCard_' + card.childId + '.png';
    withBusy(this, 'Saving…', function () {
      return canvasBlob(cardCanvas()).then(function (blob) {
        saveBlob(blob, name);
        showMsg('Card saved as ' + name);
      });
    });
  });

  $('share').addEventListener('click', function () {
    if (!card) return;
    var name = 'ChildCard_' + card.childId + '.png';
    var l = card.orgName || card.orgLabel || 'Organization';
    withBusy(this, 'Sharing…', function () {
      return canvasBlob(cardCanvas()).then(function (blob) {
        return shareOrSave(blob, name, l + ' - ' + card.childName + ' Registration Card', shareText());
      }).then(function (r) {
        if (r === 'saved') showMsg('Sharing is not available on this device, so the card was saved instead.');
      });
    });
  });

  $('shareQr').addEventListener('click', function () {
    if (!card || !card.qrImage) return;
    var name = 'qr_' + card.childId + '.png';
    withBusy(this, 'Sharing…', function () {
      return canvasBlob(qrCanvas()).then(function (blob) {
        return shareOrSave(blob, name, 'QR Code for ' + card.childName,
          'QR Code for ' + card.childName + ' (ID: ' + card.childId + ')');
      }).then(function (r) {
        if (r === 'saved') showMsg('Sharing is not available on this device, so the QR code was saved instead.');
      });
    });
  });

  /* ---------- opening the page: check the link first ---------- */
  function gateShow(title, msg) {
    $('step1').classList.add('hidden');
    $('step2').classList.add('hidden');
    $('steps').classList.add('hidden');
    $('gate').classList.remove('hidden');
    $('hg').textContent = title;
    $('gateMsg').textContent = msg;
  }

  function checkLink() {
    if (!TOKEN_RE.test(TOKEN)) {
      gateShow('Link not valid', 'This registration link is not valid. Please ask your admin for the correct link.');
      return;
    }
    call({ action: 'info', token: TOKEN })
      .then(function (res) {
        if (!res.success) {
          gateShow('Link not valid', res.error || 'This registration link is not valid. Please ask your admin for the correct link.');
          return;
        }
        org.name = res.orgName || '';
        org.label = res.orgLabel || 'Organization';
        setupClassroom();
        $('orgName').textContent = org.name || "Children's department";
        document.title = 'Vantora – Register your child' + (org.name ? ' – ' + org.name : '');
        if (!res.open) {
          gateShow('Registration unavailable', res.message || "Registration is not available right now. Please speak to your children's department admin.");
          return;
        }
        $('steps').classList.remove('hidden');
        setStep(1);
      })
      .catch(function (e) {
        gateShow('Could not open the page', (e && e.message) || 'Network problem. Check your internet and try again.');
      });
  }

  /* ---------- register another child: keep parent details and pickup persons, clear child + security answer ---------- */
  $('another').addEventListener('click', function () {
    ['childName', 'dob', 'age', 'classroom', 'classroomSelect', 'securityAnswer'].forEach(function (id) { $(id).value = ''; });
    $('securityAnswer').type = 'password';
    $('toggleAnswer').textContent = 'Show';
    card = null;
    $('qrImg').removeAttribute('src');
    showMsg('');
    setStep(1);
    $('childName').focus();
  });

  updatePickupUi();
  checkLink();
})();
