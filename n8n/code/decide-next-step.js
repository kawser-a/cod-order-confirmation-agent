// Decide next step
// Gemini has read the customer's reply. This node applies the shop's rules:
// what the order's status becomes, what gets saved, and what the customer is
// told. The AI suggests, the code decides.

const msg = $("Parse message").first().json;
const { order, chat_id } = $("Prepare AI request").first().json;
const response = $input.first().json;
const now = new Date().toISOString();

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const bn = (n) =>
    Math.round(Number(n)).toLocaleString("en-US").replace(/\d/g, (d) => BN_DIGITS[d]);

// Customers type numbers in Bangla digits, with spaces, or with +88, and Google
// Sheets drops the leading 0 if a number is stored as a number. Normalise all
// of these to 01XXXXXXXXX.
function normalisePhone(raw) {
    let digits = String(raw || "")
        .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
        .replace(/\D/g, "");
    if (digits.startsWith("880")) digits = digits.slice(2);
    if (/^1[3-9]\d{8}$/.test(digits)) digits = "0" + digits;
    return digits;
}
const isValidPhone = (p) => /^01[3-9]\d{8}$/.test(p);

// Every column the Update order node writes. Start from the row's current
// values so nothing is blanked by accident.
const row = {
    status: order.status,
    address: order.address,
    phone: normalisePhone(order.phone) || order.phone,
    telegram_chat_id: order.telegram_chat_id,
    last_message_at: now,
    risk_flags: order.risk_flags,
    cancel_reason: order.cancel_reason,
    // "[unclear]" marks one unclear reply; any clear reply resets it.
    seller_note: String(order.seller_note || "").replace("[unclear]", "").trim(),
    last_transcript: order.last_transcript,
    tokens_used: order.tokens_used,
};

function done(action, replyText, changes = {}) {
    return [
        {
            json: {
                action,
                chat_id,
                reply_text: replyText,
                should_update_sheet: true,
                order_id: order.order_id,
                ...row,
                ...changes,
            },
        },
    ];
}

const HANDOVER = "ধন্যবাদ! আপনার বিষয়টি আমাদের টিম দেখছে, শিগগিরই যোগাযোগ করবে।";

// 1. Read Gemini's answer. Any failure goes to a person, never to a guess.
let ai = null;
try {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    ai = JSON.parse(text);
} catch (e) {
    ai = null;
}
if (!ai || !ai.intent || !ai.reply) {
    const why = response.error ? JSON.stringify(response.error).slice(0, 150) : "no usable AI answer";
    return done("ai_failed", HANDOVER, { status: "needs_seller", seller_note: `AI failed: ${why}` });
}

row.tokens_used = Number(order.tokens_used || 0) + Number(response.usageMetadata?.totalTokenCount || 0);
if (ai.transcript) row.last_transcript = ai.transcript;
const customerWords = ai.transcript || msg.text || "(voice note)";

// 2. Risk flags: keep the code's own checks, refresh the address one with the AI's judgement.
const flags = new Set(String(order.risk_flags || "").split(",").map((f) => f.trim()).filter(Boolean));
const setFlag = (name, on) => (on ? flags.add(name) : flags.delete(name));
const saveFlags = () => (row.risk_flags = [...flags].join(", "));
setFlag("address_incomplete", ai.address_complete === false);

const zoneChanged =
    typeof ai.address_in_dhaka === "boolean" &&
    (ai.address_in_dhaka ? "inside_dhaka" : "outside_dhaka") !== order.delivery_zone;

function summaryFor(address, phone) {
    return [
        "",
        `অর্ডার #${order.order_id}: ${order.items} × ${bn(order.quantity)}`,
        `মোট: ${bn(order.total_bdt)} টাকা, ক্যাশ অন ডেলিভারি`,
        `ঠিকানা: ${address}`,
        `ফোন: ${phone}`,
        `সব ঠিক থাকলে "হ্যাঁ" লিখুন।`,
    ].join("\n");
}

// 3. The rules.
switch (ai.intent) {
    case "confirm": {
        if (!isValidPhone(normalisePhone(row.phone))) {
            setFlag("invalid_phone", true);
            saveFlags();
            return done("ask_phone", "কনফার্ম করার আগে আপনার সঠিক ১১ ডিজিটের মোবাইল নম্বরটি দিন, যেমন 01712345678।");
        }
        if (ai.address_complete === false) {
            saveFlags();
            return done("ask_address", "কনফার্ম করার আগে পুরো ঠিকানাটি দিন: বাসা/রোড বা গ্রাম, এলাকা বা থানা, এবং জেলা।");
        }
        saveFlags();
        return done("confirmed", ai.reply, { status: "confirmed" });
    }

    case "change_address": {
        if (!ai.new_address) {
            saveFlags();
            return done("ask_address", "নতুন ঠিকানাটি লিখে পাঠান: বাসা/রোড বা গ্রাম, এলাকা বা থানা, এবং জেলা।");
        }
        row.address = ai.new_address;
        saveFlags();
        if (zoneChanged) {
            // A move in or out of Dhaka changes the delivery charge. The code never changes prices.
            return done("needs_seller", "ঠিকানাটি নোট করেছি। ঢাকার ভেতর/বাইরে পরিবর্তনের কারণে ডেলিভারি চার্জ বদলাতে পারে, আমাদের টিম আপনাকে জানাবে।", {
                status: "needs_seller",
                seller_note: `Address changed across delivery zones (was ${order.delivery_zone}). Update the delivery charge and total.`,
            });
        }
        if (ai.address_complete === false) {
            return done("ask_address", "ঠিকানাটি নোট করেছি, তবে আরেকটু বিস্তারিত দিন: বাসা/রোড বা গ্রাম, এলাকা বা থানা, এবং জেলা।");
        }
        return done("address_updated", ai.reply + "\n" + summaryFor(row.address, row.phone));
    }

    case "change_phone": {
        const phone = normalisePhone(ai.new_phone);
        if (!isValidPhone(phone)) {
            return done("ask_phone", "নম্বরটি সঠিক মনে হচ্ছে না। ১১ ডিজিটের মোবাইল নম্বরটি দিন, যেমন 01712345678।");
        }
        row.phone = phone;
        setFlag("invalid_phone", false);
        saveFlags();
        return done("phone_updated", ai.reply + "\n" + summaryFor(row.address, row.phone));
    }

    case "change_items":
        saveFlags();
        return done("needs_seller", ai.reply, {
            status: "needs_seller",
            seller_note: `Customer wants to change items: "${customerWords}"`,
        });

    case "cancel":
        saveFlags();
        return done("cancelled", ai.reply, { status: "cancelled", cancel_reason: ai.cancel_reason || "no reason given" });

    case "question":
        saveFlags();
        return done("answered", ai.reply);

    case "unclear":
        saveFlags();
        if (String(order.seller_note || "").includes("[unclear]")) {
            // Second unclear reply in a row: stop asking and hand it to a person.
            return done("needs_seller", HANDOVER, {
                status: "needs_seller",
                seller_note: `Unclear twice. Last message: "${customerWords}"`,
            });
        }
        return done("ask_again", ai.reply, { seller_note: "[unclear]" });

    default:
        saveFlags();
        return done("needs_seller", HANDOVER, {
            status: "needs_seller",
            seller_note: `Needs a person: "${customerWords}"`,
        });
}
