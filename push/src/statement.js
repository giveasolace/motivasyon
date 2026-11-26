// Kredi kartı ekstresini Claude ile okuyup Cüzdan işlemlerine çevirir.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5-5';
const DAILY_LIMIT = 30;

const SYSTEM = `Sen Türk bankalarının kredi kartı ekstrelerini okuyan bir asistansın (TEB, VakıfBank ve diğerleri).
Görev: Ekstredeki her harcama/iade satırını çıkar ve verilen kategori listesinden uygun kategoriyi seç.

Kurallar:
- Karta yapılan ödemeleri ("ÖDEME", "HESAPTAN ÖDEME", "OTOMATİK ÖDEME", "TAHSİLAT" vb.), önceki dönem/devreden bakiye satırlarını, dönem toplamlarını, asgari ödeme ve limit bilgilerini ÇIKARMA.
- Harcamalar type="out". İadeler / iptaller / puan-bonus-chip para iadesi gibi karta geri gelen tutarlar type="in".
- Taksitli işlemlerde bu ekstreye yansıyan o ayın taksit tutarını al; "3/6" gibi taksit bilgisini installment alanına yaz (yoksa "").
- Faiz, gecikme faizi, BSMV, KKDF, kart aidatı ve banka ücretlerini de type="out" olarak çıkar; kategori olarak "Kart/Borç" benzeri kategoriyi seç.
- amount: Türk lirası, pozitif sayı (ondalık nokta ile). Dövizli işlemlerde ekstredeki TL karşılığını kullan.
- date: YYYY-MM-DD. Ekstrede yıl yazmıyorsa dönemin yılını kullan (Aralık dönemindeki Ocak tarihleri için yılı doğru ayarla).
- desc: satırdaki işyeri/açıklama, kısa ve okunur (gereksiz kart numarası, referans kodu, şehir kodlarını at).
- cat: verilen listedeki kategori id'lerinden biri. Örnekler: Migros/A101/BİM/ŞOK/CarrefourSA → market; restoran/kafe/Yemeksepeti/Getir Yemek → yemek; Shell/Opet/BP/Petrol Ofisi/otopark/HGS/OGS/taksi/havayolu → ulaşım; elektrik/su/doğalgaz/internet/telefon faturası → fatura; Netflix/Spotify/YouTube/Apple/Google abonelikleri → abonelik; eczane/hastane → sağlık; giyim/ayakkabı mağazaları → giyim; sinema/oyun/konser → eğlence; kitap/kurs/okul → eğitim. Uymuyorsa "diğer" benzeri kategori.
- card: kartın banka/kart adı (ör. "TEB Bonus", "VakıfBank World"); period: ekstre dönemi/kesim tarihi (ör. "Kasım 2026"); total: ekstrede yazan dönem borcu/toplam (yoksa 0).
- Hiç işlem bulamazsan items boş liste olsun. Uydurma satır ekleme.`;

function schema(cats) {
  const ids = [...new Set([...(cats.out || []), ...(cats.in || [])].map(c => c.id))];
  return {
    type: 'object',
    properties: {
      card: { type: 'string' },
      period: { type: 'string' },
      total: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            desc: { type: 'string' },
            amount: { type: 'number' },
            type: { type: 'string', enum: ['out', 'in'] },
            cat: { type: 'string', enum: ids },
            installment: { type: 'string' },
          },
          required: ['date', 'desc', 'amount', 'type', 'cat', 'installment'],
          additionalProperties: false,
        },
      },
    },
    required: ['card', 'period', 'total', 'items'],
    additionalProperties: false,
  };
}

function cleanCats(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60)
    .filter(c => c && typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id))
    .map(c => ({ id: c.id, name: String(c.name || c.id).slice(0, 40) }));
}

export async function handleStatement(body, env, json) {
  if (!env.STATEMENT_TOKEN || body.token !== env.STATEMENT_TOKEN) return json({ error: 'Erişim kodu yanlış' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Sunucuda API anahtarı tanımlı değil' }, 503);

  const cats = { out: cleanCats(body.cats?.out), in: cleanCats(body.cats?.in) };
  if (!cats.out.length || !cats.in.length) return json({ error: 'Kategori listesi eksik' }, 400);

  const content = [];
  if (body.image?.data) {
    const mt = body.image.media_type;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mt) || body.image.data.length > 7_000_000) return json({ error: 'Görsel desteklenmiyor ya da çok büyük' }, 400);
    content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: body.image.data } });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > 300_000) return json({ error: 'Ekstre metni çok uzun' }, 400);
  if (!text.trim() && !content.length) return json({ error: 'Ekstre içeriği boş' }, 400);

  // Günlük limit (API kredisini korumak için)
  const dayKey = 'stmt:' + new Date().toISOString().slice(0, 10);
  const used = parseInt((await env.SUBS.get(dayKey)) || '0', 10);
  if (used >= DAILY_LIMIT) return json({ error: 'Bugünlük ekstre okuma limiti doldu' }, 429);
  await env.SUBS.put(dayKey, String(used + 1), { expirationTtl: 2 * 86400 });

  const catList = `Gider kategorileri: ${cats.out.map(c => `${c.id} (${c.name})`).join(', ')}\nGelir kategorileri: ${cats.in.map(c => `${c.id} (${c.name})`).join(', ')}`;
  const year = /^\d{4}$/.test(String(body.year)) ? body.year : new Date().getFullYear();
  content.push({ type: 'text', text: `${catList}\nBugünün yılı: ${year}\n\n${text ? 'Ekstre metni:\n' + text : 'Ekstre yukarıdaki görselde.'}` });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: schema(cats) } },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'API anahtarı geçersiz' }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Yapay zeka şu an yoğun, biraz sonra dene' }, 503);
    if (e instanceof Anthropic.APIConnectionError) return json({ error: 'Yapay zekaya bağlanılamadı' }, 502);
    if (e instanceof Anthropic.APIError) return json({ error: e.status === 402 || e.type === 'billing_error' ? 'API kredisi bitti (Billing)' : 'Yapay zeka hatası: ' + (e.message || e.status) }, 502);
    throw e;
  }

  if (response.stop_reason === 'refusal') return json({ error: 'Ekstre işlenemedi (reddedildi)' }, 422);
  if (response.stop_reason === 'max_tokens') return json({ error: 'Ekstre çok uzun; sayfa sayfa yükle' }, 422);
  const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let data;
  try { data = JSON.parse(out); } catch { return json({ error: 'Cevap okunamadı' }, 502); }

  const u = response.usage || {};
  const costUsd = ((u.input_tokens || 0) * 2 + (u.output_tokens || 0) * 10) / 1e6; // Sonnet 5.5: $2 / $10 per MTok
  return json({ ok: true, model: response.model, ...data, usage: { input: u.input_tokens, output: u.output_tokens, costUsd: Math.round(costUsd * 10000) / 10000 } }, 200);
}
