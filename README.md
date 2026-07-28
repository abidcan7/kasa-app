# KASA Mobil — arayüz

KASA ikinci-beyin sisteminin telefon yüzü. Saf HTML/CSS/JS, **build adımı yok**, bağımlılık yok.

> Bu depo yalnızca **arayüz kodudur** ve bu yüzden public'tir.
> Kişisel veri burada **yoktur**; veriler ayrı bir private depoda (`kasa-veri`) durur ve
> uygulama oraya kullanıcının kendi cihazında sakladığı bir GitHub token'ı ile bağlanır.

## Yayın

GitHub Pages → `https://<kullanici>.github.io/kasa-app/`

## Dosyalar

| Dosya | İş |
|---|---|
| `index.html` | iskelet: üst bar, görünümler, alt gezinme, yakala/ayar/detay sayfaları |
| `app.css` | tek renk sistemi, açık/koyu tema, mobil-öncelikli düzen |
| `app.js` | GitHub istemcisi, çevrimdışı olay kuyruğu, görünüm çizimi |
| `sw.js` | service worker — uygulama kabuğunu önbelleğe alır (API asla önbelleklenmez) |
| `manifest.webmanifest` | PWA tanımı |
| `ikon/` | uygulama ikonları |

## Çalışma mantığı

Uygulama veriyi **asla doğrudan değiştirmez**. Her işlem `kasa-veri/inbox/` altına bir
olay dosyası (JSON) yazar. Vault tarafındaki asistan bu olayları okuyup markdown'a işler
ve veriyi yeniden üretir. Aynı dosya iki yerden yazılmadığı için çakışma oluşmaz.

```
data/*.json   → uygulama okur   (bugun, hafta, takvim, biriken, durum, meta)
inbox/*.json  → uygulama yazar  (gorev_durum, altgorev_*, not_ekle, gorev_ekle, ...)
```

## Ayarlar

İlk açılışta sorulur; `localStorage` içinde cihazda kalır:
`owner`, `repo`, `token` (fine-grained PAT — yalnızca veri deposunda `Contents: read/write`).
