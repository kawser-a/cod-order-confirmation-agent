// Ask for text
// Voice notes, stickers and photos aren't understood yet. Reply politely
// instead of leaving the customer with silence.

const msg = $("Parse message").first().json;

return [
    {
        json: {
            action: "unsupported_message",
            chat_id: msg.chat_id,
            reply_text:
                'দুঃখিত, এই মুহূর্তে শুধু লেখা মেসেজ বুঝতে পারি। অনুগ্রহ করে লিখে উত্তর দিন, যেমন "হ্যাঁ" অথবা কী বদলাতে চান।',
            should_update_sheet: false,
        },
    },
];
