// Quote computation — SPEC.md fee model.
// total = item price (tax incl.) + quote fee + handling fee + shipping
import {
  QUOTE_FEE_JPY,
  MIN_HANDLING_FEE_JPY,
  TERMS,
  ZONES,
  getService,
} from "./catalog.js";

function jstWeekday(date) {
  // 0=Sunday … 6=Saturday, in Asia/Tokyo
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
}

export function fxRate() {
  const r = Number(process.env.HFA_USDJPY_RATE);
  return Number.isFinite(r) && r > 0 ? r : 150; // fallback; fixed & stated at quote time
}

function round100(n) {
  return Math.round(n / 100) * 100;
}

export function computeQuote(input, now = new Date()) {
  const service = getService(input.service_id);
  if (!service) {
    return { error: "unknown_service", message: `Unknown service_id: ${input.service_id}` };
  }

  // Restaurants only — lodging is not in the catalog (Travel Agency Act, see SPEC.md).
  if (service.id === "phone_reservation") {
    const vt = String(
      input.details?.venue_type || input.details?.type || "restaurant",
    ).toLowerCase();
    if (/(hotel|inn|ryokan|lodging|hostel|accommodation|宿|ホテル|旅館)/.test(vt)) {
      return {
        error: "service_not_offered",
        message:
          "Lodging reservations (hotels, inns, ryokan) are not offered. phone_reservation covers restaurants only.",
      };
    }
  }

  // Item price
  let itemPrice = 0;
  if (Array.isArray(input.items) && input.items.length > 0) {
    for (const it of input.items) {
      const p = Number(it.estimated_price_jpy ?? it.price_jpy ?? 0);
      const q = Number(it.quantity ?? 1);
      if (!Number.isFinite(p) || p < 0) {
        return { error: "invalid_item_price", message: "Each item needs estimated_price_jpy >= 0." };
      }
      itemPrice += p * (Number.isFinite(q) && q > 0 ? q : 1);
    }
  } else if (input.item_price_jpy != null) {
    itemPrice = Number(input.item_price_jpy);
    if (!Number.isFinite(itemPrice) || itemPrice < 0) {
      return { error: "invalid_item_price", message: "item_price_jpy must be a finite number >= 0." };
    }
  }
  if (service.requires_item_price && !(itemPrice > 0)) {
    return {
      error: "item_price_required",
      message: `${service.id} requires items[] with estimated_price_jpy, or item_price_jpy (tax incl.).`,
    };
  }

  // Handling fee
  let handling = service.handling_fee_jpy;
  let hours = null;
  if (service.unit === "per_hour") {
    hours = Number(input.hours ?? 1);
    if (!Number.isFinite(hours) || hours < 1) hours = 1;
    handling = service.handling_fee_jpy * hours;
  }

  // Zone adjustments
  const area = String(input.area || input.details?.area || "").toLowerCase();
  const zoneNotes = [];
  let zone = null;
  if (area.includes("akihabara") || area.includes("秋葉原")) {
    const z = ZONES.akihabara;
    if (z.applies_to.includes(service.id)) {
      zone = "akihabara";
      handling = round100(handling * (1 + z.handling_surcharge_rate));
      const wd = jstWeekday(now);
      const weekday = wd >= 1 && wd <= 5;
      zoneNotes.push(z.note_en);
      zoneNotes.push(
        weekday
          ? "Today is a weekday in Tokyo: daily-run eligibility will be confirmed at operator review."
          : "Today is a weekend in Tokyo: the daily run does not operate. Scheduling is confirmed at operator review.",
      );
    }
  } else if (area.includes("ginza") || area.includes("銀座")) {
    const z = ZONES.ginza;
    if (z.applies_to.includes(service.id)) {
      zone = "ginza";
      handling += z.handling_surcharge_jpy;
      zoneNotes.push(z.note_en);
    }
  }
  if (handling < MIN_HANDLING_FEE_JPY) handling = MIN_HANDLING_FEE_JPY;

  let shipping = service.default_shipping_jpy;
  if (input.shipping_jpy != null) {
    const s = Number(input.shipping_jpy);
    if (!Number.isFinite(s) || s < 0) {
      return { error: "invalid_shipping", message: "shipping_jpy must be a finite number >= 0." };
    }
    shipping = s;
  }

  const totalJpy = itemPrice + QUOTE_FEE_JPY + handling + shipping;

  const currency = String(input.currency || "JPY").toUpperCase() === "USD" ? "USD" : "JPY";
  const rate = fxRate();
  const validHours = TERMS.quote_validity_hours;

  const quote = {
    service_id: service.id,
    service_name_en: service.name_en,
    service_name_ja: service.name_ja,
    area: area || null,
    zone,
    zone_notes: zoneNotes,
    hours,
    currency,
    breakdown: {
      item_price_jpy: itemPrice,
      quote_fee_jpy: QUOTE_FEE_JPY,
      handling_fee_jpy: handling,
      shipping_jpy: shipping,
      total_jpy: totalJpy,
    },
    fx:
      currency === "USD"
        ? {
            pair: "USD/JPY",
            jpy_per_usd: rate,
            fixed_at: now.toISOString(),
            total_usd: Math.round((totalJpy / rate) * 100) / 100,
            note: "Rate is fixed at quote time and stated here, per terms.",
          }
        : null,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + validHours * 3600_000).toISOString(),
    terms: TERMS,
    notes: [
      "Quotes are instant; execution is not. Accepting a quote places the request in pending_review — a human operator confirms or declines each request individually during the launch phase.",
      "No start time, same-day handling, or completion time is promised before review completes.",
      "The quote fee (JPY 2,200) is charged as part of the total when you accept this quote, and is non-refundable once charged. Requesting this quote was free.",
    ],
  };
  return { quote };
}
