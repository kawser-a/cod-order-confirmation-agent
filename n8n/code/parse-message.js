// Parse message
// Turns a raw Telegram update into one flat shape the rest of the workflow
// relies on, whether the customer tapped an order link, typed a reply, or
// sent a voice note.

const msg = $input.first().json.message || {};
const text = (msg.text || "").trim();
const audio = msg.voice || msg.audio || null;

let kind = "other";
let orderId = null;

const start = text.match(/^\/start(?:\s+(\S+))?$/);
if (start) {
    kind = "start";
    // Deep-link payloads can be anything, so accept only a plain order number.
    orderId = start[1] && /^\d{1,10}$/.test(start[1]) ? start[1] : null;
} else if (audio) {
    kind = "voice";
} else if (text) {
    kind = "text";
}

return [
    {
        json: {
            kind, // start | text | voice | other
            order_id: orderId, // only set for kind = start
            chat_id: String(msg.chat?.id ?? ""), // stored as text so long IDs stay exact
            text: kind === "text" ? text.slice(0, 1000) : "",
            voice_file_id: audio?.file_id ?? null,
            voice_duration_s: audio?.duration ?? null,
            customer_first_name: msg.from?.first_name ?? "",
            received_at: new Date((msg.date || 0) * 1000).toISOString(),
        },
    },
];
