// Build confirmation
// Runs when a customer opens an order link. Decides what to send and builds
// the confirmation message from the sheet. Prices and totals come from the
// sheet, never from the AI, so the message can't get them wrong.

const msg = $("Parse message").first().json;
const order = $("Find order").first().json;
const pastOrders = $("Past orders").all().map((item) => item.json);
const now = new Date().toISOString();

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const bn = (n) =>
    Math.round(Number(n)).toLocaleString("en-US").replace(/\d/g, (d) => BN_DIGITS[d]);
const ZONE_LABEL = { inside_dhaka: "ঢাকার ভেতরে", outside_dhaka: "ঢাকার বাইরে" };

function result(action, replyText, sheetUpdate = null) {
    return [
        {
            json: {
                action,
                chat_id: msg.chat_id,
                reply_text: replyText,
                should_update_sheet: sheetUpdate !== null,
                row_number: order.row_number ?? null,
                order_id: order.order_id ?? msg.order_id,
                ...(sheetUpdate || {}),
            },
        },
    ];
}

// 1. No such order, or the bot was opened without an order link.
if (!msg.order_id || !order.order_id) {
    return result(
        "not_found",
        "দুঃখিত, এই অর্ডারটি খুঁজে পাইনি। দোকানের দেওয়া লিংকটি আবার চেষ্টা করুন, অথবা আমাদের পেজে মেসেজ দিন।"
    );
}

// 2. The order is already linked to a different Telegram account.
//    Order numbers are easy to guess, so never show one customer's address to someone else.
if (order.telegram_chat_id && order.telegram_chat_id !== msg.chat_id) {
    return result("wrong_chat", "দুঃখিত, এই অর্ডারটি অন্য একটি একাউন্টের সাথে যুক্ত। সাহায্যের জন্য আমাদের পেজে মেসেজ দিন।");
}

// 3. Already handled: don't restart a finished conversation.
const STATUS_TEXT = {
    confirmed: "এই অর্ডারটি ইতিমধ্যে কনফার্ম করা হয়েছে। ধন্যবাদ!",
    cancelled: "এই অর্ডারটি বাতিল করা হয়েছে। নতুন করে অর্ডার করতে আমাদের পেজে মেসেজ দিন।",
    needs_seller: "আপনার অর্ডারটি আমাদের টিম দেখছে, শিগগিরই যোগাযোগ করবে।",
    no_response: "আপনার অর্ডারটি আমাদের টিম দেখছে, শিগগিরই যোগাযোগ করবে।",
};
if (STATUS_TEXT[order.status]) {
    return result("already_handled", STATUS_TEXT[order.status]);
}

// 4. Risk flags: signals for the seller, computed by rules, not by the AI.
const qty = Number(order.quantity);
const unit = Number(order.unit_price_bdt);
const delivery = Number(order.delivery_charge_bdt);
const total = Number(order.total_bdt);
const flags = [];

if (!/^01[3-9]\d{8}$/.test(String(order.phone).trim())) flags.push("invalid_phone");
if (String(order.address).split(",").filter((p) => p.trim()).length < 3) flags.push("address_incomplete");
if (total > 5000) flags.push("high_value");
if (pastOrders.some((p) => p.phone === order.phone && p.order_id !== order.order_id && p.status === "cancelled")) {
    flags.push("cancelled_before");
}
const totalIsWrong = qty * unit + delivery !== total;
if (totalIsWrong) flags.push("total_mismatch");

// 5. A wrong total must never reach the customer. Hand it to the seller instead.
if (totalIsWrong) {
    return result("needs_seller", "ধন্যবাদ! আপনার অর্ডারটি আমরা একটু যাচাই করছি, শিগগিরই জানাবো।", {
        status: "needs_seller",
        telegram_chat_id: msg.chat_id,
        last_message_at: now,
        risk_flags: flags.join(", "),
        seller_note: `Total in sheet is ${total}, but ${qty} x ${unit} + ${delivery} = ${qty * unit + delivery}. Fix the row, then resend the link.`,
    });
}

// 6. The confirmation message.
const firstName = String(order.customer_name).trim().split(/\s+/)[0];
const text = [
    `আসসালামু আলাইকুম ${firstName}! COD Demo Shop থেকে আপনার অর্ডারটি কনফার্ম করছি:`,
    "",
    `অর্ডার #${order.order_id}`,
    `• ${order.items} × ${bn(qty)} — ${bn(qty * unit)} টাকা`,
    `• ডেলিভারি চার্জ (${ZONE_LABEL[order.delivery_zone] || order.delivery_zone}) — ${bn(delivery)} টাকা`,
    `মোট: ${bn(total)} টাকা, ক্যাশ অন ডেলিভারি`,
    `ঠিকানা: ${order.address}`,
    `ফোন: ${order.phone}`,
    "",
    `সব ঠিক থাকলে "হ্যাঁ" লিখুন বা ভয়েস পাঠান। কিছু বদলাতে চাইলে জানান।`,
].join("\n");

return result("send_confirmation", text, {
    status: "awaiting_customer",
    telegram_chat_id: msg.chat_id,
    last_message_at: now,
    risk_flags: flags.join(", "),
});
