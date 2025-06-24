const dotenv = require('dotenv');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const envConfig = dotenv.config({ path: path.resolve(__dirname, 'variables.env') });

if (envConfig.error) {
  // This error should never happen if the file is present
  console.warn('Warning: Could not load variables.env file. Using default fallbacks or environment variables already set.', envConfig.error);
} else if (Object.keys(envConfig.parsed || {}).length === 0) {
  console.warn('Warning: variables.env file was found but is empty or contains no valid variables.');
} else {
  console.log('Successfully loaded variables from variables.env');
}
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash", // Or other suitable multimodal model
});

const generationConfig = {
    temperature: 0.2, // Adjust as needed
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 10000, // Adjust as needed
    responseMimeType: "text/plain",
};

// --- Webhook Verification ---
app.get('/webhook', (req, res) => {
    console.log("webhook get method got called.");
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log(VERIFY_TOKEN);

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// --- Handle Incoming WhatsApp Messages ---
app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log('Incoming webhook:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from;

        if (message.type === 'audio') {
            const audioId = message.audio.id;
            console.log(`Received audio message with ID: ${audioId} from ${from}`);
            try {
                // 1. Get Media URL
                const mediaUrlResponse = await axios.get(
                    `https://graph.facebook.com/v19.0/${audioId}`, // Use your preferred API version
                    { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
                );
                const mediaUrl = mediaUrlResponse.data.url;

                // 2. Download Audio directly into a buffer
                const audioResponse = await axios.get(mediaUrl, {
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                    responseType: 'arraybuffer'
                });
                const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                const mimeType = message.audio.mime_type || 'audio/ogg; codecs=opus';

                // 3. Transcribe with Gemini (NO file system needed)
                console.log('Sending audio buffer directly to Gemini for transcription...');
                const audioFilePart = {
                    inlineData: {
                        data: audioBuffer.toString("base64"), // Gemini expects base64 encoded data
                        mimeType: mimeType,
                    },
                };

                const result = await model.generateContent({
                    contents: [{ role: "user", parts: [audioFilePart, { text: "please transcribe this audio file" }] }], // Simplified prompt
                    generationConfig,
                });

                const transcribedText = result.response.text();
                console.log('Gemini Transcription:', transcribedText);

                // 4. Send Transcribed Text back to WhatsApp
                await sendSplitMessage(from, `Transcription: ${transcribedText}`);

                // NO NEED TO CLEAN UP A FILE, AS WE NEVER CREATED ONE!

            } catch (error) {
                const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
                console.error('Error processing audio:', errorMessage);
                await sendSplitMessage(from, "Sorry, I couldn't process your audio right now.");
            }
        } else if (message.type === 'text') {
            await sendSplitMessage(from, `You said: ${message.text.body}`);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});
// --- Function to Send WhatsApp Message ---
async function sendWhatsAppMessage(to, text) {
    console.log(`Sending message to ${to}: ${text}`);
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, // Use current API version
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text },
            },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        console.log('Message sent successfully.');
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
    }
}
// A simple helper function for creating a delay
// A simple helper function for creating a delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handles sending a message of any length by splitting it into chunks if it exceeds the WhatsApp API limit.
 * This version correctly reserves space for the "(x/y)" prefix.
 *
 * @param {string} to - The recipient's phone number.
 * @param {string} longText - The full text message to send.
 * @param {number} delayBetweenMessages - Milliseconds to wait between sending each part.
 */
async function sendSplitMessage(to, longText, delayBetweenMessages = 1500) {
    const MAX_LENGTH = 4096;
    // *** FIX: Reserve characters for the prefix, e.g., "(10/12) ". 20 chars is a safe buffer.
    const PREFIX_RESERVATION = 20;
    const CHUNK_SIZE = MAX_LENGTH - PREFIX_RESERVATION;

    // If the message is short enough, send it in one go.
    if (longText.length <= MAX_LENGTH) {
        // No need to split, just send the original function
        await sendWhatsAppMessage(to, longText);
        return;
    }

    // --- Splitting Logic ---
    const chunks = [];
    // *** FIX: Split using the smaller CHUNK_SIZE
    for (let i = 0; i < longText.length; i += CHUNK_SIZE) {
        chunks.push(longText.substring(i, i + CHUNK_SIZE));
    }

    console.log(`Message is too long. Splitting into ${chunks.length} parts.`);

    // --- Sending Loop ---
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            // Add a prefix to indicate message parts. The total length will now be safe.
            const messagePart = `(${i + 1}/${chunks.length}) ${chunk}`;
            
            // This call should now always succeed as messagePart will be < 4096 chars
            await sendWhatsAppMessage(to, messagePart);

            // Wait for a short duration between messages to ensure order and avoid rate limits.
            if (i < chunks.length - 1) {
                await delay(delayBetweenMessages);
            }
        } catch (error) {
            console.error(`Failed to send part ${i + 1} of the message. Aborting remaining parts.`);
            // Stop sending the rest of the messages if one fails.
            return;
        }
    }

    console.log('All parts of the long message have been sent.');
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Make sure this server is publicly accessible for WhatsApp Webhooks.');
    console.log('If running locally, use ngrok: ngrok http ' + PORT);
});