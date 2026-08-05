/* ===========================================================================
   KASA Mobil — uygulama mantığı

   Mimari notu: bu uygulama vault'un KOPYASINI gösterir ve asla veriyi doğrudan
   değiştirmez. Yapılan her işlem `inbox/` klasörüne bir OLAY dosyası olarak
   yazılır. Claude bu olayları okuyup KASA kurallarına göre markdown'a işler ve
   veriyi yeniden üretir. Böylece çakışma olmaz ve hiçbir bilgi kaybolmaz.
   =========================================================================== */

'use strict';

/* olcek: Kadir'in tercihi "Devasa" (28.07) — yeni cihazlarda da bu gelsin */
const VARSAYILAN = { owner: 'abidcan7', repo: 'kasa-veri', dal: 'main', olcek: 1.65 };
const DOSYALAR = ['meta', 'bugun', 'hafta', 'takvim', 'biriken', 'durum'];

/* ------------------------------------------------------------------ depo */

const Depo = {
  al(anahtar, varsayilan) {
    try { const h = localStorage.getItem('kasa.' + anahtar); return h === null ? varsayilan : JSON.parse(h); }
    catch (e) { return varsayilan; }
  },
  yaz(anahtar, deger) { localStorage.setItem('kasa.' + anahtar, JSON.stringify(deger)); },
  sil(anahtar) { localStorage.removeItem('kasa.' + anahtar); }
};

const Ayar = {
  get owner() { return Depo.al('owner', VARSAYILAN.owner); },
  get repo()  { return Depo.al('repo',  VARSAYILAN.repo); },
  get dal()   { return Depo.al('dal',   VARSAYILAN.dal); },
  get token() { return Depo.al('token', ''); },
  kurulu()    { return !!this.token; }
};

/* durum: uygulama içi bellek */
const D = {
  gorunum: 'bugun',
  veri: Depo.al('veri', {}),
  kuyruk: Depo.al('kuyruk', []),
  gecmis: Depo.al('gecmis', []), // gelen kutusuna yakalananlar (kart listesi)
  yerel: Depo.al('yerel', {}),   // henüz işlenmemiş yerel durum değişiklikleri
  sonCekme: Depo.al('sonCekme', null),
  senkronda: false
};

/* --------------------------------------------------------------- yardımcı */

const $  = (s, k) => (k || document).querySelector(s);
const $$ = (s, k) => Array.from((k || document).querySelectorAll(s));

function kacir(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bildir(mesaj, sure) {
  const el = $('#bildirim');
  el.textContent = mesaj;
  el.classList.remove('gizli');
  clearTimeout(bildir._z);
  bildir._z = setTimeout(() => el.classList.add('gizli'), sure || 2600);
}

function bugunISO() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

function yeniKimlik() {
  return 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const AYLAR = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];

function gunFarki(iso) {
  if (!iso) return null;
  const h = new Date(iso + 'T00:00:00');
  const b = new Date(bugunISO() + 'T00:00:00');
  return Math.round((h - b) / 86400000);
}

function b64(metin) {
  const baytlar = new TextEncoder().encode(metin);
  let ikili = '';
  baytlar.forEach(b => { ikili += String.fromCharCode(b); });
  return btoa(ikili);
}

/* ------------------------------------------------------------ GitHub API */

const GH = {
  async istek(yol, secenek) {
    const s = secenek || {};
    const yanit = await fetch('https://api.github.com/repos/' + Ayar.owner + '/' + Ayar.repo + yol, {
      method: s.method || 'GET',
      headers: Object.assign({
        'Authorization': 'Bearer ' + Ayar.token,
        'Accept': s.ham ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, s.headers || {}),
      body: s.body ? JSON.stringify(s.body) : undefined
    });
    if (!yanit.ok) {
      let ayrinti = '';
      try { const j = await yanit.json(); ayrinti = j.message || ''; } catch (e) {}
      const hata = new Error('GitHub ' + yanit.status + (ayrinti ? ' — ' + ayrinti : ''));
      hata.kod = yanit.status;
      throw hata;
    }
    return yanit;
  },

  async jsonOku(ad) {
    const y = await this.istek('/contents/data/' + ad + '.json?ref=' + Ayar.dal, { ham: true });
    return await y.json();
  },

  async olayYaz(olay) {
    const ad = 'inbox/' + olay.ts.replace(/[:.]/g, '-') + '-' + olay.id.slice(-6) + '.json';
    await this.istek('/contents/' + ad, {
      method: 'PUT',
      body: {
        message: 'mobil: ' + olay.tip,
        content: b64(JSON.stringify(olay, null, 2)),
        branch: Ayar.dal
      }
    });
  },

  /* ikili dosya (foto / ses / pdf) yükler — içerik zaten base64 */
  async dosyaYaz(yol, base64Icerik, mesaj) {
    await this.istek('/contents/' + yol, {
      method: 'PUT',
      body: { message: mesaj || ('mobil ek: ' + yol), content: base64Icerik, branch: Ayar.dal }
    });
  }
};

/* ------------------------------------------------------------- medya araçları */

function dosyaOku(dosya) {
  return new Promise((coz, red) => {
    const fr = new FileReader();
    fr.onload = () => coz(fr.result);
    fr.onerror = red;
    fr.readAsDataURL(dosya);
  });
}

function veriUrlAyir(veriUrl) {
  const i = veriUrl.indexOf(',');
  return veriUrl.slice(i + 1);           // yalnızca base64 gövdesi
}

/* Tuval gerçekten çizildi mi? Bozuk çözümde her piksel aynı (genelde saf siyah)
   çıkıyor. Köşeler + merkezden örnek alıp hepsi aynı mı diye bakıyoruz. */
function tuvalBos(ctx, g, y) {
  const noktalar = [[1, 1], [g - 2, 1], [1, y - 2], [g - 2, y - 2], [g >> 1, y >> 1]];
  let ilk = null;
  for (const [x, k] of noktalar) {
    if (x < 0 || k < 0) continue;
    const p = ctx.getImageData(x, k, 1, 1).data;
    const imza = p[0] + ',' + p[1] + ',' + p[2];
    if (ilk === null) ilk = imza;
    else if (imza !== ilk) return false;   // farklı renk bulundu → tuval dolu
  }
  return true;                              // hepsi aynı → şüpheli, ham dosyaya düş
}

/* Telefon fotoğrafları 3-5 MB gelir; yüklemeden önce küçültülür.
   Böylece mobil veriyle de hızlı gider ve depo şişmez.
   null dönerse çağıran taraf ham dosyayı gönderir (kayıp olmaz). */
function gorseliKucult(dosya, maxKenar, kalite) {
  maxKenar = maxKenar || 1600; kalite = kalite || 0.82;
  return (async () => {
    let kaynak = null, g = 0, y = 0, temizle = null;

    // 1) En güvenilir yol: createImageBitmap bitmap'i çözülmüş hâlde verir.
    try {
      if (typeof createImageBitmap === 'function') {
        kaynak = await createImageBitmap(dosya);
        g = kaynak.width; y = kaynak.height;
        temizle = () => { try { kaynak.close && kaynak.close(); } catch (_) {} };
      }
    } catch (_) { kaynak = null; }

    // 2) Yedek yol: <img>. ⚠️ onload YETMİYOR — bitmap henüz çözülmemiş olabiliyor
    //    ve tuval tamamen siyah çıkıyordu (29.07 hatası, 12 görüntü kaybedildi).
    //    decode() çözümün tamamlandığını garanti eder.
    if (!kaynak) {
      const url = URL.createObjectURL(dosya);
      const img = new Image();
      img.src = url;
      try {
        if (img.decode) await img.decode();
        else await new Promise((ok, hata) => { img.onload = ok; img.onerror = hata; });
      } catch (_) { URL.revokeObjectURL(url); return null; }
      kaynak = img; g = img.naturalWidth; y = img.naturalHeight;
      temizle = () => URL.revokeObjectURL(url);
    }

    if (!g || !y) { temizle && temizle(); return null; }

    const oran = Math.min(1, maxKenar / Math.max(g, y));
    g = Math.max(1, Math.round(g * oran)); y = Math.max(1, Math.round(y * oran));
    const c = document.createElement('canvas');
    c.width = g; c.height = y;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try { ctx.drawImage(kaynak, 0, 0, g, y); }
    catch (_) { temizle && temizle(); return null; }
    temizle && temizle();

    // 3) Son kontrol: tek renk çıktıysa küçültmeye güvenme, ham dosyayı gönder.
    try { if (tuvalBos(ctx, g, y)) return null; } catch (_) { /* CORS vb. → devam */ }

    return c.toDataURL('image/jpeg', kalite);
  })();
}

const Ekler = {
  liste: [],   // { ad, tur, uzanti, base64, onizleme }

  async dosyaEkle(dosya) {
    let base64, uzanti, tur, onizleme = null;
    if (dosya.type.startsWith('image/')) {
      const kucuk = await gorseliKucult(dosya);
      const veriUrl = kucuk || (await dosyaOku(dosya));   // küçültme başarısızsa ham dosya
      base64 = veriUrlAyir(veriUrl);
      onizleme = veriUrl; tur = 'foto';
      // Ham dosyaya düşüldüyse uzantı gerçek türü yansıtsın (png'yi jpg diye kaydetme).
      uzanti = kucuk ? 'jpg'
             : ((/^data:image\/([a-z0-9+.-]+)/i.exec(veriUrl) || [, 'jpg'])[1]
                 .replace('jpeg', 'jpg').toLowerCase());
    } else {
      base64 = veriUrlAyir(await dosyaOku(dosya));
      uzanti = (dosya.name.split('.').pop() || 'bin').toLowerCase();
      tur = 'dosya';
    }
    this.liste.push({ ad: dosya.name || ('ek.' + uzanti), tur, uzanti, base64, onizleme });
    this.ciz();
  },

  sesEkle(base64, saniye) {
    this.liste.push({ ad: 'sesli-not-' + saniye + 'sn.webm', tur: 'ses', uzanti: 'webm', base64, onizleme: null });
    this.ciz();
  },

  sil(i) { this.liste.splice(i, 1); this.ciz(); },
  temizle() { this.liste = []; this.ciz(); },

  ciz() {
    const el = $('#ekListesi');
    if (!el) return;
    el.innerHTML = this.liste.map((e, i) => {
      const ikon = e.tur === 'foto' ? '🖼️' : (e.tur === 'ses' ? '🎤' : '📄');
      const gor = e.onizleme ? '<img src="' + e.onizleme + '" alt="">' : '<span>' + ikon + '</span>';
      const kb = Math.round(e.base64.length * 0.75 / 1024);
      return '<span class="ek-fis">' + gor +
             '<span class="ad">' + kacir(e.ad) + '</span>' +
             '<span style="opacity:.7">' + kb + 'KB</span>' +
             '<button class="sil" data-ek="' + i + '" aria-label="Kaldır">✕</button></span>';
    }).join('');
    $$('.ek-fis .sil', el).forEach(b => b.onclick = () => this.sil(parseInt(b.dataset.ek, 10)));
  },

  /* Ekleri GitHub'a yükler, olayda kullanılacak yol listesini döndürür */
  async yukle(zamanDamgasi) {
    const sonuc = [];
    for (let i = 0; i < this.liste.length; i++) {
      const e = this.liste[i];
      const yol = 'inbox/ekler/' + zamanDamgasi + '-' + (i + 1) + '.' + e.uzanti;
      await GH.dosyaYaz(yol, e.base64, 'mobil ek: ' + e.ad);
      sonuc.push({ ad: e.ad, yol: yol, tur: e.tur });
    }
    return sonuc;
  }
};

const SesKaydi = {
  kaydedici: null, parcalar: [], baslangic: 0, sayac: null,

  async basla() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      bildir('Bu tarayıcı ses kaydını desteklemiyor'); return;
    }
    try {
      const akis = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.parcalar = [];
      this.kaydedici = new MediaRecorder(akis);
      this.kaydedici.ondataavailable = ev => { if (ev.data.size) this.parcalar.push(ev.data); };
      this.kaydedici.onstop = () => akis.getTracks().forEach(t => t.stop());
      this.kaydedici.start();
      this.baslangic = Date.now();
      $('#kayitPanel').classList.remove('gizli');
      $('#ekSes').classList.add('etkin');
      this.sayac = setInterval(() => {
        const s = Math.floor((Date.now() - this.baslangic) / 1000);
        $('#kayitSure').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 250);
    } catch (e) {
      bildir('Mikrofon izni verilmedi');
    }
  },

  bitir(kaydet) {
    if (!this.kaydedici) return;
    const sure = Math.max(1, Math.round((Date.now() - this.baslangic) / 1000));
    clearInterval(this.sayac);
    this.kaydedici.onstop = async () => {
      if (kaydet && this.parcalar.length) {
        const blob = new Blob(this.parcalar, { type: 'audio/webm' });
        Ekler.sesEkle(veriUrlAyir(await dosyaOku(blob)), sure);
        bildir('Sesli not eklendi (' + sure + 'sn)');
      }
      this.parcalar = [];
    };
    try { this.kaydedici.stop(); } catch (e) {}
    this.kaydedici = null;
    $('#kayitPanel').classList.add('gizli');
    $('#ekSes').classList.remove('etkin');
    $('#kayitSure').textContent = '0:00';
  }
};

/* ------------------------------------------------------------- senkron */

const Senkron = {
  async cek() {
    if (!Ayar.kurulu()) { AyarSayfasi.ac('Başlamak için GitHub bağlantısını kur.'); return; }
    if (D.senkronda) return;
    D.senkronda = true;
    $('#senkronBtn').classList.add('doner');
    try {
      await this.kuyrugaBosalt();

      const yeni = {};
      for (const ad of DOSYALAR) {
        try { yeni[ad] = await GH.jsonOku(ad); }
        catch (e) { if (e.kod !== 404) throw e; }
      }
      if (yeni.meta) {
        // Claude yeni veri üretmişse, ondan eski yerel değişiklikleri temizle
        const uretim = new Date(yeni.meta.uretim).getTime();
        let temiz = {};
        for (const k in D.yerel) if (D.yerel[k].ts > uretim) temiz[k] = D.yerel[k];
        D.yerel = temiz;
        Depo.yaz('yerel', D.yerel);
      }
      D.veri = yeni;
      D.sonCekme = new Date().toISOString();
      Depo.yaz('veri', D.veri);
      Depo.yaz('sonCekme', D.sonCekme);
      Gelen.isleniyorMu();     // vault'a işlenmiş yakalamaları "işlendi" işaretle
      ciz();
      bildir('Güncel');
    } catch (e) {
      bildir(e.kod === 401 ? 'Anahtar geçersiz — Ayarlar' : (e.kod === 404 ? 'Depo/dosya bulunamadı' : 'Bağlantı yok, çevrimdışı'));
      serit();
    } finally {
      D.senkronda = false;
      $('#senkronBtn').classList.remove('doner');
    }
  },

  /* kuyruktaki olayları GitHub'a yaz */
  async kuyrugaBosalt() {
    if (!D.kuyruk.length) return;
    const kalan = [];
    for (const olay of D.kuyruk) {
      try {
        await GH.olayYaz(olay);
        Gelen.durumYaz(olay.id, 'gonderildi');
      }
      catch (e) {
        // 422 = dosya zaten var → olay ASLINDA teslim edilmiş demektir.
        // Bunu hata sayıp kuyrukta tutmak, olayın ileride tekrar yüklenmesine
        // ve vault'ta çift işlenmeye yol açıyordu (28.07'de yaşandı).
        if (e.kod === 422) { Gelen.durumYaz(olay.id, 'gonderildi'); continue; }
        kalan.push(olay);
      }
    }
    D.kuyruk = kalan;
    Depo.yaz('kuyruk', D.kuyruk);
    serit();
  },

  /* olayı kuyruğa koy, hemen göndermeyi dene */
  gonder(tip, veri, baglam) {
    const olay = {
      id: yeniKimlik(),
      ts: new Date().toISOString(),
      kaynak: 'mobil',
      tip: tip,
      veri: veri,
      baglam: baglam || null
    };
    D.kuyruk.push(olay);
    Depo.yaz('kuyruk', D.kuyruk);
    serit();
    if (navigator.onLine && Ayar.kurulu()) {
      this.kuyrugaBosalt().catch(() => {});
    }
    return olay;
  }
};

function serit() {
  const el = $('#senkronSerit');
  if (D.kuyruk.length) {
    el.textContent = '↑ ' + D.kuyruk.length + ' değişiklik gönderilmeyi bekliyor' + (navigator.onLine ? '' : ' (çevrimdışı)');
    el.classList.remove('gizli');
    el.classList.toggle('uyari', !navigator.onLine);
  } else {
    el.classList.add('gizli');
  }

  /* masaüstü yan panelin dip bilgisi */
  const yd = $('#yanDurum');
  if (!yd) return;
  const satir = [];
  if (!navigator.onLine) satir.push('<b>Çevrimdışı</b>');
  else if (D.kuyruk.length) satir.push('<b>' + D.kuyruk.length + '</b> bekliyor');
  else satir.push('<b>Güncel</b>');
  if (D.sonCekme) satir.push('son senkron ' + new Date(D.sonCekme).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
  yd.innerHTML = satir.join('<br>');
}

/* ------------------------------------------------------------- gelen kutusu */

const TUR_IKON = { not: '📝', sonuc: '✅', fikir: '💡', arastir: '🔍', gorev: '☑️', etkinlik: '📅', mesaj: '💬' };

const Gelen = {
  ekle(olayId, tur, metin, ekler) {
    D.gecmis.unshift({
      olayId: olayId, ts: new Date().toISOString(),
      tur: tur, metin: metin, ekler: ekler || [], durum: 'bekliyor'
    });
    if (D.gecmis.length > 80) D.gecmis.length = 80;   // yerel geçmişi sınırla
    Depo.yaz('gecmis', D.gecmis);
  },

  durumYaz(olayId, durum) {
    const k = D.gecmis.find(x => x.olayId === olayId);
    if (k && k.durum !== 'islendi') { k.durum = durum; Depo.yaz('gecmis', D.gecmis); }
  },

  /* Vault'tan yeni veri geldiğinde: metni günlük notta bulduysak "işlendi" say */
  isleniyorMu() {
    const notlar = (D.veri.bugun && D.veri.bugun.gunIciNotlar) || [];
    if (!notlar.length) return;
    let degisti = false;
    D.gecmis.forEach(k => {
      if (k.durum === 'islendi' || !k.metin) return;
      const parca = k.metin.trim().slice(0, 24).toLowerCase();
      if (parca.length < 6) return;
      if (notlar.some(n => (n.metin || '').toLowerCase().includes(parca))) { k.durum = 'islendi'; degisti = true; }
    });
    if (degisti) Depo.yaz('gecmis', D.gecmis);
  }
};

function cizGelen() {
  if (!D.gecmis.length) {
    return bosDurum('📥', 'Gelen kutusu boş',
      'Yukarıdan aklına geleni yaz. Not, yapıldı kaydı, fikir, fotoğraf, sesli not — hepsi buraya düşer, Claude doğru yere dağıtır.');
  }
  const rozetAd = { bekliyor: 'bekliyor', gonderildi: 'gönderildi', islendi: 'işlendi' };
  let h = '<div class="bolum-bas">Yakaladıklarım<span class="sayi">' + D.gecmis.length + '</span></div>';
  D.gecmis.forEach(k => {
    const t = new Date(k.ts);
    const zaman = t.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }) + ' · ' +
                  t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    h += '<div class="gelen-kart">' +
      '<div class="gelen-ust">' +
        '<span class="gelen-tur">' + (TUR_IKON[k.tur] || '📝') + '</span>' +
        '<span class="gelen-zaman">' + kacir(zaman) + '</span>' +
        '<span class="gelen-rozet ' + k.durum + '">' + (rozetAd[k.durum] || k.durum) + '</span>' +
      '</div>' +
      (k.metin ? '<div class="gelen-metin">' + kacir(k.metin) + '</div>' : '') +
      ((k.ekler || []).length
        ? '<div class="gelen-ekler">' + k.ekler.map(e =>
            '<span class="gelen-ek">' + (e.tur === 'foto' ? '🖼️' : e.tur === 'ses' ? '🎤' : '📄') + ' ' + kacir(e.ad) + '</span>'
          ).join('') + '</div>'
        : '') +
    '</div>';
  });
  return h;
}

/* ---------------------------------------------------------- durum yönetimi */

const DURUMLAR = ['acik', 'basladi', 'bitti'];

function durumAl(id, sunucuDurum) {
  const y = D.yerel[id];
  return y ? y.durum : sunucuDurum;
}

function durumYaz(id, durum) {
  D.yerel[id] = { durum: durum, ts: Date.now() };
  Depo.yaz('yerel', D.yerel);
}

function sonrakiDurum(d) {
  const i = DURUMLAR.indexOf(d);
  return DURUMLAR[(i < 0 ? 0 : i + 1) % DURUMLAR.length];
}

function gorevBul(id) {
  const b = D.veri.bugun;
  if (!b || !b.gorevler) return null;
  for (const g of b.gorevler) if (g.id === id) return g;
  return null;
}

/* -------------------------------------------------------------- görünümler */

const kutuSVG = '<span class="nokta"></span><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';

function gorevKarti(g) {
  const durum = durumAl(g.id, g.durum);
  const altAcik = (g.altGorevler || []).filter(a => durumAl(a.id, a.durum) !== 'bitti').length;
  const altTop = (g.altGorevler || []).length;
  const notSay = (g.notlar || []).length;

  let rozet = '';
  if (g.sure) rozet += '<span class="rozet sure">' + kacir(g.sure) + '</span>';
  (g.baglar || []).slice(0, 2).forEach(b => { rozet += '<span class="rozet">' + kacir(b) + '</span>'; });
  if (altTop) rozet += '<span class="rozet alt">☑ ' + (altTop - altAcik) + '/' + altTop + '</span>';
  if (notSay) rozet += '<span class="rozet alt">💬 ' + notSay + '</span>';
  if (durum === 'basladi') rozet = '<span class="rozet basladi">başladı</span>' + rozet;

  return '<div class="gorev" data-durum="' + durum + '" data-id="' + kacir(g.id) + '">' +
    '<button class="kutu" data-eylem="dongu" aria-label="Durum değiştir">' + kutuSVG + '</button>' +
    '<div class="gorev-govde" data-eylem="detay">' +
      '<div class="gorev-metin">' + kacir(g.metin) + '</div>' +
      (rozet ? '<div class="rozetler">' + rozet + '</div>' : '') +
    '</div>' +
    '<button class="gorev-ac" data-eylem="detay" aria-label="Ayrıntı">' +
      '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>' +
  '</div>';
}

/* blok saatini ("8-10", "20-00") ayrıştırıp şu an aktif mi bak */
function blokAktifMi(saat) {
  const m = String(saat || '').match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
  if (!m) return false;
  let bas = parseInt(m[1], 10), son = parseInt(m[2], 10);
  if (son === 0) son = 24;
  const s = new Date().getHours();
  return s >= bas && s < son;
}

function cizBugun() {
  const b = D.veri.bugun;
  if (!b) return bosDurum('📭', 'Henüz veri çekilmedi', 'Yukarıdaki yenile düğmesine bas.');

  const gorevler = b.gorevler || [];
  const acik  = gorevler.filter(g => durumAl(g.id, g.durum) !== 'bitti');
  const bitti = gorevler.filter(g => durumAl(g.id, g.durum) === 'bitti');
  const notlar = (b.gunIciNotlar || []).filter(n => n.metin);
  const bloklar = b.bloklar || [];

  /* --- sol sütun: odak + görevler --- */
  let sol = '';
  if (b.odak) {
    sol += '<div class="odak"><div class="etiket">Günün tek önemli işi</div>' +
           '<div class="metin">' + kacir(b.odak) + '</div></div>';
  }
  if (!gorevler.length) {
    sol += bosDurum('🎉', 'Bugün için görev yok', 'Yakala düğmesiyle ekleyebilirsin.');
  } else {
    sol += '<div class="bolum-bas">Görevler<span class="sayi">' + acik.length + ' açık</span></div>';
    sol += acik.length
      ? '<div class="liste">' + acik.map(gorevKarti).join('') + '</div>'
      : '<div class="liste"><div class="bilgi-satir">Hepsi bitti 🎉</div></div>';
    if (bitti.length) {
      sol += '<div class="bolum-bas">Tamamlanan<span class="sayi">' + bitti.length + '</span></div>';
      sol += '<div class="liste">' + bitti.map(gorevKarti).join('') + '</div>';
    }
  }

  /* --- sağ sütun: zaman blokları + gün içi notlar --- */
  let sag = '';
  if (bloklar.length) {
    sag += '<div class="bolum-bas">Zaman blokları</div><div class="liste">';
    bloklar.forEach(bl => {
      const aktif = blokAktifMi(bl.saat);
      sag += '<div class="blok' + (aktif ? ' aktif' : '') + '">' +
        '<div class="blok-saat">' + kacir(bl.saat) + '</div>' +
        '<div class="blok-govde">' +
          '<div class="blok-ad">' + kacir(bl.ad) + (bl.konum ? ' · ' + kacir(bl.konum) : '') + '</div>' +
          '<div class="blok-plan">' + kacir(bl.plan || '—') + '</div>' +
          (bl.yapilan ? '<div class="rozetler"><span class="rozet yesil">✓ ' + kacir(bl.yapilan) + '</span></div>' : '') +
        '</div></div>';
    });
    sag += '</div>';
  }
  if (notlar.length) {
    sag += '<div class="bolum-bas">Gün içi notlar</div><div class="liste">';
    notlar.forEach(n => {
      sag += '<div class="bilgi-satir">' +
             (n.saat ? '<span class="saat">' + kacir(n.saat) + '</span>' : '') +
             '<span>' + kacir(n.metin) + '</span></div>';
    });
    sag += '</div>';
  }

  const ikiSutun = sag ? ' iki-sutun' : '';
  return '<div class="duzen' + ikiSutun + '">' +
           '<div class="sutun-ana">' + sol + '</div>' +
           (sag ? '<div class="sutun-yan">' + sag + '</div>' : '') +
         '</div>';
}

function cizHafta() {
  const w = D.veri.hafta;
  if (!w) return bosDurum('🗓️', 'Haftalık plan yok', 'Senkronize et.');
  let h = '';
  if (w.ozet) h += '<div class="ozet-kart">' + kacir(w.ozet) + '</div>';

  (w.oncelikler || []).forEach(o => {
    h += '<div class="bolum-bas">' + kacir(o.etiket) + '</div><div class="liste">';
    (o.maddeler || []).forEach((m, i) => {
      h += '<div class="oncelik-madde' + (m.bitti ? ' bitti' : '') + '">' +
           '<span class="no">' + (i + 1) + '</span>' +
           '<span class="govde">' + kacir(m.metin) +
           (m.sure ? ' <span class="rozet sure">' + kacir(m.sure) + '</span>' : '') +
           '</span></div>';
    });
    h += '</div>';
  });

  const bg = bugunISO();
  h += '<div class="bolum-bas">Gün gün</div><div class="gun-izgara">';
  (w.gunler || []).forEach(g => {
    const bugunMu = g.tarih === bg;
    h += '<div class="hafta-gun' + (bugunMu ? ' bugun' : '') + '">' +
      '<h3>' + kacir(g.ad) + (bugunMu ? ' <span class="bugun-rozeti">BUGÜN</span>' : '') +
      '<span class="tarih">' + kacir(g.tarih || '') + '</span></h3>' +
      '<ul>' + (g.satirlar || []).map(s => '<li>' + kacir(s) + '</li>').join('') + '</ul></div>';
  });
  h += '</div>';

  if ((w.riskler || []).length) {
    h += '<div class="risk-kart"><h3>⚠️ Riskler</h3><ul>' +
         w.riskler.map(r => '<li>' + kacir(r) + '</li>').join('') + '</ul></div>';
  }
  return h;
}

function cizTakvim() {
  const t = D.veri.takvim;
  if (!t) return bosDurum('📅', 'Takvim yok', 'Senkronize et.');
  const yaklasan = (t.etkinlikler || []).filter(e => !e.gecmis);
  if (!yaklasan.length) return bosDurum('📅', 'Yaklaşan etkinlik yok', '');

  let h = '<div class="bolum-bas">Yaklaşan</div><div class="liste">';
  yaklasan.forEach(e => {
    const fark = gunFarki(e.tarih);
    const d = e.tarih ? new Date(e.tarih + 'T00:00:00') : null;
    let kalan = '';
    if (fark === 0) kalan = 'bugün';
    else if (fark === 1) kalan = 'yarın';
    else if (fark != null && fark > 0) kalan = fark + ' gün';
    h += '<div class="takvim-satir' + (fark != null && fark <= 7 ? ' yakin' : '') + '">' +
      '<div class="takvim-tarih">' +
        '<div class="gun">' + (d ? d.getDate() : '–') + '</div>' +
        '<div class="ay">' + (d ? AYLAR[d.getMonth()] : kacir(e.ham || '')) + '</div>' +
      '</div>' +
      '<div class="takvim-govde">' +
        '<div class="takvim-baslik">' + kacir(e.baslik) + '</div>' +
        '<div class="takvim-alt">' +
          (e.saat && e.saat !== '—' ? kacir(e.saat) + ' · ' : '') +
          (e.ilgili ? kacir(e.ilgili) + ' · ' : '') +
          '<span class="kalan-rozet">' + kalan + '</span>' +
        '</div>' +
      '</div></div>';
  });
  h += '</div>';

  if ((t.tekrarlayan || []).length) {
    h += '<div class="bolum-bas">Yıllık / tekrarlayan</div><div class="liste">';
    t.tekrarlayan.forEach(r => { h += '<div class="bilgi-satir"><span>' + kacir(r) + '</span></div>'; });
    h += '</div>';
  }
  return h;
}

function cizBiriken() {
  const b = D.veri.biriken;
  if (!b) return bosDurum('📥', 'Biriken işler yok', 'Senkronize et.');
  let h = '';
  (b.bolumler || []).forEach(bol => {
    const maddeler = (bol.maddeler || []).filter(m => m.durum !== 'bitti');
    if (!maddeler.length) return;
    h += '<div class="bolum-bas">' + kacir(bol.baslik) + '</div><div class="liste">';
    maddeler.forEach(m => {
      if (m.durum === 'bilgi' || !m.id) {
        h += '<div class="bilgi-satir"><span>' + kacir(m.metin) + '</span></div>';
        return;
      }
      const durum = durumAl(m.id, m.durum);
      h += '<div class="gorev" data-durum="' + durum + '" data-id="' + kacir(m.id) + '" data-tur="biriken">' +
        '<button class="kutu" data-eylem="dongu-biriken">' + kutuSVG + '</button>' +
        '<div class="gorev-govde"><div class="gorev-metin">' + kacir(m.metin) + '</div></div></div>';
    });
    h += '</div>';
  });
  return h || bosDurum('🎉', 'Biriken iş kalmadı', '');
}

/* soyut geometrik kompozisyon — boş ekranlar tatsız durmasın */
const BOS_SEKIL =
  '<svg class="bos-sekil" viewBox="0 0 200 130" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="var(--vurgu)"/><stop offset="1" stop-color="var(--vurgu-2)"/></linearGradient>' +
      '<linearGradient id="bg2" x1="1" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="var(--vurgu-2)"/><stop offset="1" stop-color="#f0709a"/></linearGradient>' +
    '</defs>' +
    '<circle cx="72" cy="62" r="34" fill="url(#bg1)" opacity=".85"/>' +
    '<rect x="96" y="30" width="58" height="58" rx="16" fill="url(#bg2)" opacity=".62"/>' +
    '<circle cx="140" cy="88" r="19" fill="none" stroke="url(#bg1)" stroke-width="5" opacity=".75"/>' +
    '<path d="M28 96 L58 44 L88 96 Z" fill="none" stroke="url(#bg2)" stroke-width="4.5" stroke-linejoin="round" opacity=".55"/>' +
  '</svg>';

function bosDurum(ikon, baslik, alt) {
  return '<div class="bos-durum">' + BOS_SEKIL +
         '<b>' + kacir(baslik) + '</b>' +
         (alt ? '<div>' + kacir(alt) + '</div>' : '') + '</div>';
}

/* ------------------------------------------------------------------- çizim */

const BASLIKLAR = { bugun: 'Bugün', hafta: 'Hafta', takvim: 'Takvim', biriken: 'Biriken', gelen: 'Gelen' };

function ciz() {
  const g = D.gorunum;
  $('#baslik').textContent = BASLIKLAR[g] || 'KASA';

  let alt = '';
  if (g === 'bugun' && D.veri.bugun) alt = D.veri.bugun.tarih + ' ' + (D.veri.bugun.gunAdi || '');
  else if (g === 'hafta' && D.veri.hafta) alt = (D.veri.hafta.baslangic || '') + ' → ' + (D.veri.hafta.bitis || '');
  else if (g === 'gelen') alt = 'yakala, Claude dağıtsın';
  else if (D.sonCekme) alt = 'son senkron ' + new Date(D.sonCekme).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  $('#altBaslik').textContent = alt;

  /* besteci yalnızca Gelen kutusunda görünür (kalıcı DOM — yazılan metin kaybolmaz) */
  $('#besteci').classList.toggle('gizli', g !== 'gelen');

  let h = '';
  if (g === 'bugun') h = cizBugun();
  else if (g === 'hafta') h = cizHafta();
  else if (g === 'takvim') h = cizTakvim();
  else if (g === 'biriken') h = cizBiriken();
  else if (g === 'gelen') h = cizGelen();
  $('#icerik').innerHTML = h;

  $$('#anaNav button').forEach(b => b.classList.toggle('aktif', b.dataset.gorunum === g));
  serit();
}

/* --------------------------------------------------------- görev detayı */

const GorevSayfasi = {
  ac(id) {
    const g = gorevBul(id);
    if (!g) return;
    const durum = durumAl(g.id, g.durum);

    let h = '<div class="sayfa-tut"></div>';
    h += '<div class="detay-metin">' + kacir(g.metin) + '</div>';
    if (g.sure) h += '<div class="rozetler" style="margin-bottom:14px"><span class="rozet sure">' + kacir(g.sure) + '</span></div>';

    h += '<div class="durum-secim">' +
      '<button data-d="acik"    data-secili="' + (durum === 'acik' ? 1 : 0) + '">○ Açık</button>' +
      '<button data-d="basladi" data-secili="' + (durum === 'basladi' ? 1 : 0) + '">◐ Başladı</button>' +
      '<button data-d="bitti"   data-secili="' + (durum === 'bitti' ? 1 : 0) + '">✓ Bitti</button>' +
    '</div>';

    h += '<div class="detay-bas">Alt görevler</div>';
    if ((g.altGorevler || []).length) {
      g.altGorevler.forEach(a => {
        const ad = durumAl(a.id, a.durum);
        h += '<div class="alt-gorev" data-durum="' + ad + '" data-alt="' + kacir(a.id) + '">' +
             '<button class="kutu">' + kutuSVG + '</button><span>' + kacir(a.metin) + '</span></div>';
      });
    } else {
      h += '<div class="ipucu" style="margin:0">Henüz alt görev yok.</div>';
    }
    h += '<div class="ekle-satir"><input type="text" id="altYeni" placeholder="Alt görev ekle…"><button id="altEkleBtn">Ekle</button></div>';

    if ((g.notlar || []).length) {
      h += '<div class="detay-bas">Notlar</div>';
      const tipIkon = { not: '📝', mesaj: '💬', sonuc: '✅', arastir: '🔍' };
      g.notlar.forEach(n => {
        h += '<div class="not-satir"><span class="tip">' + (tipIkon[n.tip] || '📝') + '</span>' +
             '<span>' + kacir(n.metin) + (n.saat ? ' <span class="saat">' + kacir(n.saat) + '</span>' : '') + '</span></div>';
      });
    }

    h += '<div class="detay-bas">Erteleme</div>';
    h += '<div class="ekle-satir"><input type="date" id="erteleTarih" value="' + bugunISO() + '"><button id="erteleBtn">Ertele</button></div>';

    h += '<div class="detay-bas">Bu göreve not ekle</div>';
    h += '<div class="ekle-satir"><input type="text" id="gorevNot" placeholder="Gelişme / ama / karar…"><button id="gorevNotBtn">Ekle</button></div>';

    h += '<div class="kaynak-not">Kaynak: ' + kacir(g.kaynak || '') + ' · kimlik <code>' + kacir(g.id) + '</code></div>';

    $('#gorevSayfa').innerHTML = h;
    $('#gorevKatman').classList.remove('gizli');
    this.aktif = g;
    this.bagla(g);
  },

  bagla(g) {
    const sayfa = $('#gorevSayfa');

    $$('.durum-secim button', sayfa).forEach(b => b.onclick = () => {
      const yeni = b.dataset.d;
      const eski = durumAl(g.id, g.durum);
      if (yeni === eski) return;
      durumYaz(g.id, yeni);
      Senkron.gonder('gorev_durum', { gorevId: g.id, eski: eski, yeni: yeni },
                     { metin: g.metin, kaynak: g.kaynak });
      bildir(yeni === 'bitti' ? 'Bitti ✓' : (yeni === 'basladi' ? 'Başladı' : 'Açık'));
      this.ac(g.id); ciz();
    });

    $$('.alt-gorev', sayfa).forEach(el => el.querySelector('.kutu').onclick = () => {
      const aid = el.dataset.alt;
      const alt = (g.altGorevler || []).find(a => a.id === aid);
      if (!alt) return;
      const eski = durumAl(aid, alt.durum);
      const yeni = eski === 'bitti' ? 'acik' : 'bitti';
      durumYaz(aid, yeni);
      Senkron.gonder('altgorev_durum', { gorevId: g.id, altGorevId: aid, eski: eski, yeni: yeni },
                     { metin: alt.metin, ustGorev: g.metin, kaynak: g.kaynak });
      this.ac(g.id); ciz();
    });

    $('#altEkleBtn', sayfa).onclick = () => {
      const gir = $('#altYeni', sayfa);
      const m = gir.value.trim();
      if (!m) return;
      Senkron.gonder('altgorev_ekle', { gorevId: g.id, metin: m }, { ustGorev: g.metin, kaynak: g.kaynak });
      gir.value = '';
      bildir('Alt görev kuyruğa alındı');
    };

    $('#erteleBtn', sayfa).onclick = () => {
      const t = $('#erteleTarih', sayfa).value;
      if (!t) return;
      Senkron.gonder('gorev_ertele', { gorevId: g.id, hedefTarih: t }, { metin: g.metin, kaynak: g.kaynak });
      bildir(t + ' tarihine ertelendi');
      Katman.kapat();
    };

    $('#gorevNotBtn', sayfa).onclick = () => {
      const gir = $('#gorevNot', sayfa);
      const m = gir.value.trim();
      if (!m) return;
      Senkron.gonder('gorev_not', { gorevId: g.id, metin: m }, { ustGorev: g.metin, kaynak: g.kaynak });
      gir.value = '';
      bildir('Not kuyruğa alındı');
    };
  }
};

/* ---------------------------------------------------------------- katmanlar */

const Katman = {
  kapat() { $$('.katman').forEach(k => k.classList.add('gizli')); }
};

/* ---------------------------------------------------------------- ölçek */
/* Tüm arayüzü orantılı büyütür (yazı + düğme + boşluk). `zoom`, düzeni
   yeniden akıttığı için transform:scale'den farklı olarak taşma yaratmaz. */
const Olcek = {
  uygula(deger) {
    const d = parseFloat(deger) || 1;
    document.documentElement.style.zoom = d === 1 ? '' : String(d);
    Depo.yaz('olcek', d);
    $$('#olcekSecim button').forEach(b => b.classList.toggle('aktif', parseFloat(b.dataset.olcek) === d));
  },
  baslat() { this.uygula(Depo.al('olcek', VARSAYILAN.olcek)); }
};

const AyarSayfasi = {
  ac(mesaj) {
    $('#ayarOwner').value = Ayar.owner;
    $('#ayarRepo').value  = Ayar.repo;
    $('#ayarToken').value = Ayar.token;
    const d = Depo.al('olcek', VARSAYILAN.olcek);
    $$('#olcekSecim button').forEach(b => b.classList.toggle('aktif', parseFloat(b.dataset.olcek) === d));
    $('#ayarDurum').innerHTML = mesaj ? kacir(mesaj) : this.ozet();
    $('#ayarKatman').classList.remove('gizli');
  },
  ozet() {
    const s = [];
    s.push(Ayar.kurulu() ? '<span class="ok">✓ Bağlı</span>' : '<span class="hata">Anahtar yok</span>');
    if (D.sonCekme) s.push('Son senkron: ' + new Date(D.sonCekme).toLocaleString('tr-TR'));
    if (D.kuyruk.length) s.push('Kuyrukta ' + D.kuyruk.length + ' değişiklik');
    const m = D.veri.meta;
    if (m) s.push('Veri üretimi: ' + new Date(m.uretim).toLocaleString('tr-TR'));

    /* teşhis — düzen sorunlarını uzaktan anlayabilmek için */
    const gen = document.documentElement.clientWidth;
    const dokunmatik = window.matchMedia('(pointer: coarse)').matches;
    const masaustuDuzen = window.matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches;
    s.push('<br><b>Teşhis</b>');
    s.push('Arayüz sürümü: <b>s=7</b>');
    s.push('Viewport: <b>' + gen + 'px</b>' + (gen > 700 && dokunmatik ? ' ⚠️ (telefonda beklenen ~400px — Chrome “Masaüstü sitesi” açık olabilir)' : ''));
    s.push('Giriş: ' + (dokunmatik ? 'dokunmatik' : 'fare') + ' · Düzen: ' + (masaustuDuzen ? 'masaüstü' : 'mobil'));
    return s.join('<br>');
  }
};

/* ------------------------------------------------------------------ olaylar */

function baglaOlaylar() {
  $$('#anaNav button').forEach(b => b.onclick = () => {
    D.gorunum = b.dataset.gorunum;
    window.scrollTo(0, 0);
    ciz();
    if (D.gorunum === 'gelen') setTimeout(() => { const t = $('#yakalaNot'); if (t) t.focus(); }, 120);
  });

  $('#senkronBtn').onclick = () => Senkron.cek();
  $('#ayarBtn').onclick = () => AyarSayfasi.ac();
  $$('[data-kapat]').forEach(e => e.onclick = () => Katman.kapat());

  /* içerik tıklamaları (delege) */
  $('#icerik').addEventListener('click', ev => {
    const gorevEl = ev.target.closest('.gorev');
    if (!gorevEl || !gorevEl.dataset.id) return;
    const eylemEl = ev.target.closest('[data-eylem]');
    const eylem = eylemEl ? eylemEl.dataset.eylem : null;
    const id = gorevEl.dataset.id;

    if (eylem === 'detay') { GorevSayfasi.ac(id); return; }

    if (eylem === 'dongu') {
      const g = gorevBul(id); if (!g) return;
      const eski = durumAl(id, g.durum);
      const yeni = sonrakiDurum(eski);
      durumYaz(id, yeni);
      Senkron.gonder('gorev_durum', { gorevId: id, eski: eski, yeni: yeni }, { metin: g.metin, kaynak: g.kaynak });
      gorevEl.dataset.durum = yeni;
      bildir(yeni === 'bitti' ? 'Bitti ✓' : (yeni === 'basladi' ? 'Başladı' : 'Açık'));
      setTimeout(ciz, 260);
      return;
    }

    if (eylem === 'dongu-biriken') {
      const eski = gorevEl.dataset.durum;
      const yeni = eski === 'bitti' ? 'acik' : 'bitti';
      durumYaz(id, yeni);
      const metin = $('.gorev-metin', gorevEl).textContent;
      Senkron.gonder('biriken_durum', { maddeId: id, eski: eski, yeni: yeni },
                     { metin: metin, kaynak: 'Biriken İşler.md' });
      gorevEl.dataset.durum = yeni;
      bildir(yeni === 'bitti' ? 'Bitti ✓' : 'Açık');
      setTimeout(ciz, 260);
    }
  });

  /* yakala sekmeleri */
  $$('.sekme').forEach(s => s.onclick = () => {
    $$('.sekme').forEach(x => x.classList.toggle('aktif', x === s));
    $$('.sekme-icerik').forEach(x => x.classList.toggle('gizli', x.dataset.icerik !== s.dataset.sekme));
  });

  /* ---- gelen kutusu: tür seçici ---- */
  let seciliTur = 'not';
  $$('#turSecim .tur').forEach(t => t.onclick = () => {
    seciliTur = t.dataset.tur;
    $$('#turSecim .tur').forEach(x => x.classList.toggle('aktif', x === t));
  });

  /* ---- gelen kutusu: ekler ---- */
  $('#ekKamera').onclick = () => $('#dosyaKamera').click();
  $('#ekGaleri').onclick = () => $('#dosyaGaleri').click();

  const dosyaAl = async (girdi) => {
    for (const d of Array.from(girdi.files || [])) {
      try { await Ekler.dosyaEkle(d); }
      catch (e) { bildir('Dosya okunamadı: ' + d.name); }
    }
    girdi.value = '';
  };
  $('#dosyaKamera').onchange = ev => dosyaAl(ev.target);
  $('#dosyaGaleri').onchange = ev => dosyaAl(ev.target);

  $('#ekSes').onclick = () => { if (SesKaydi.kaydedici) SesKaydi.bitir(true); else SesKaydi.basla(); };
  $('#kayitDur').onclick = () => SesKaydi.bitir(true);
  $('#kayitIptal').onclick = () => SesKaydi.bitir(false);

  $('#ekLink').onclick = () => {
    const u = prompt('Bağlantı (URL):');
    if (!u) return;
    const el = $('#yakalaNot');
    el.value = (el.value ? el.value.trimEnd() + '\n' : '') + u.trim();
    el.focus();
  };

  /* ---- gelen kutusu: kaydet ---- */
  $('#notKaydet').onclick = async () => {
    const el = $('#yakalaNot');
    const m = el.value.trim();
    if (!m && !Ekler.liste.length) { bildir('Önce bir şeyler yaz veya ek koy'); return; }

    const btn = $('#notKaydet');
    let ekYollari = [];
    if (Ekler.liste.length) {
      if (!navigator.onLine || !Ayar.kurulu()) {
        bildir('Ek göndermek için bağlantı gerekiyor'); return;
      }
      btn.disabled = true; btn.textContent = 'Ekler yükleniyor…';
      try {
        ekYollari = await Ekler.yukle(new Date().toISOString().replace(/[:.]/g, '-'));
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Gelen kutusuna ekle';
        bildir('Ek yüklenemedi: ' + e.message); return;
      }
      btn.disabled = false; btn.textContent = 'Gelen kutusuna ekle';
    }

    const olay = Senkron.gonder('not_ekle', {
      metin: m, tur: seciliTur, tarih: bugunISO(), ekler: ekYollari
    });
    Gelen.ekle(olay.id, seciliTur, m, ekYollari);

    el.value = '';
    Ekler.temizle();
    if (D.gorunum !== 'gelen') { D.gorunum = 'gelen'; }
    ciz();
    bildir('Gelen kutusuna eklendi');
  };

  $('#gorevKaydet').onclick = () => {
    const m = $('#yakalaGorev').value.trim();
    if (!m) return;
    const veri = {
      metin: m,
      tarih: $('#yakalaGorevTarih').value || bugunISO(),
      sure: $('#yakalaGorevSure').value.trim() || null,
      proje: $('#yakalaGorevProje').value.trim() || null
    };
    const olay = Senkron.gonder('gorev_ekle', veri);
    Gelen.ekle(olay.id, 'gorev', m + (veri.proje ? ' · ' + veri.proje : '') + ' · ' + veri.tarih, []);
    $('#yakalaGorev').value = ''; $('#yakalaGorevSure').value = ''; $('#yakalaGorevProje').value = '';
    ciz();
    bildir('Görev eklendi');
  };

  $('#etkinlikKaydet').onclick = () => {
    const m = $('#yakalaEtkinlik').value.trim();
    const t = $('#yakalaEtkinlikTarih').value;
    if (!m || !t) { bildir('Ad ve tarih gerekli'); return; }
    const saat = $('#yakalaEtkinlikSaat').value || null;
    const olay = Senkron.gonder('etkinlik_ekle', { baslik: m, tarih: t, saat: saat });
    Gelen.ekle(olay.id, 'etkinlik', m + ' · ' + t + (saat ? ' ' + saat : ''), []);
    $('#yakalaEtkinlik').value = ''; $('#yakalaEtkinlikSaat').value = '';
    ciz();
    bildir('Takvime eklendi');
  };

  $('#ayarKaydet').onclick = async () => {
    Depo.yaz('owner', $('#ayarOwner').value.trim());
    Depo.yaz('repo',  $('#ayarRepo').value.trim());
    Depo.yaz('token', $('#ayarToken').value.trim());
    $('#ayarDurum').innerHTML = 'Bağlanılıyor…';
    try {
      await GH.jsonOku('meta');
      $('#ayarDurum').innerHTML = '<span class="ok">✓ Bağlantı başarılı</span>';
      Katman.kapat();
      Senkron.cek();
    } catch (e) {
      $('#ayarDurum').innerHTML = '<span class="hata">' + kacir(e.message) + '</span>';
    }
  };

  $$('#olcekSecim button').forEach(b => b.onclick = () => {
    Olcek.uygula(b.dataset.olcek);
    bildir('Boyut: ' + b.textContent);
  });

  $('#ayarYenile').onclick = () => { Katman.kapat(); Senkron.cek(); };

  $('#ayarSil').onclick = () => {
    if (!confirm('Erişim anahtarı bu cihazdan silinsin mi?')) return;
    Depo.sil('token');
    $('#ayarToken').value = '';
    $('#ayarDurum').innerHTML = '<span class="hata">Anahtar silindi</span>';
  };

  window.addEventListener('online',  () => { serit(); Senkron.kuyrugaBosalt().catch(() => {}); });
  window.addEventListener('offline', serit);
  window.addEventListener('scroll', () => {
    $('#ustBar').classList.toggle('kaydirildi', window.scrollY > 4);
  }, { passive: true });
}

/* ------------------------------------------------------------------ başlat */

function baslat() {
  Olcek.baslat();
  baglaOlaylar();
  ciz();

  /* proje adlarını datalist'e doldur */
  const dl = $('#projeListesi');
  const projeler = new Set();
  (D.veri.bugun && D.veri.bugun.gorevler || []).forEach(g => (g.baglar || []).forEach(b => projeler.add(b)));
  dl.innerHTML = Array.from(projeler).map(p => '<option value="' + kacir(p) + '">').join('');

  if (!Ayar.kurulu()) AyarSayfasi.ac('KASA verilerine ulaşmak için GitHub bağlantısını kur.');
  else Senkron.cek();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', baslat);
