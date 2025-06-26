const dotenv = require('dotenv');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
// fs is not strictly needed anymore if we don't save files, but good to keep if future needs arise
// const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const envConfig = dotenv.config({ path: path.resolve(__dirname, 'variables.env') });

if (envConfig.error) {
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

if (!WHATSAPP_TOKEN || !VERIFY_TOKEN || !PHONE_NUMBER_ID || !GEMINI_API_KEY) {
    console.error("CRITICAL ERROR: One or more essential environment variables are missing. Please check your variables.env file or environment settings.");
    console.error("Missing WHATSAPP_ACCESS_TOKEN:", !WHATSAPP_TOKEN);
    console.error("Missing WHATSAPP_VERIFY_TOKEN:", !VERIFY_TOKEN);
    console.error("Missing WHATSAPP_PHONE_NUMBER_ID:", !PHONE_NUMBER_ID);
    console.error("Missing GEMINI_API_KEY:", !GEMINI_API_KEY);
    process.exit(1); // Exit if critical variables are missing
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash", // Using a common, up-to-date model. Adjust if "gemini-2.0-flash" is specific to your access.
});

const generationConfig = {
    temperature: 0.2,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192, // Max for gemini-1.5-flash, adjust based on actual model. WhatsApp limit is 4096 chars per message.
    responseMimeType: "text/plain",
};

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// --- Webhook Verification ---
app.get('/webhook', (req, res) => {
    console.log("Webhook GET request received.");
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log("VERIFY_TOKEN from env:", VERIFY_TOKEN); // For debugging

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.log('Webhook verification failed: Mode or token mismatch.');
            console.log(`Mode: ${mode}, Token received: ${token}, Expected token: ${VERIFY_TOKEN}`);
            res.sendStatus(403);
        }
    } else {
        console.log('Webhook verification failed: Mode or token missing from query.');
        res.sendStatus(400);
    }
});

// --- Asynchronous Message Processing Function ---
async function processWhatsAppMessage(messagePayload) {
    const message = messagePayload.entry[0].changes[0].value.messages[0];
    const from = message.from; // Sender's phone number

    try {
        if (message.type === 'audio') {
            const audioId = message.audio.id;
            console.log(`Processing audio message with ID: ${audioId} from ${from}`);

            // 1. Get Media URL
            const mediaUrlResponse = await axios.get(
                `https://graph.facebook.com/v19.0/${audioId}`,
                { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
            );

            if (!mediaUrlResponse.data || !mediaUrlResponse.data.url) {
                console.error('Failed to get media URL from WhatsApp API:', mediaUrlResponse.data);
                await sendSplitMessage(from, "Sorry, I couldn't retrieve your audio file details at the moment.");
                return;
            }
            const mediaUrl = mediaUrlResponse.data.url;

            // 2. Download Audio directly into a buffer
            const audioResponse = await axios.get(mediaUrl, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                responseType: 'arraybuffer' // Correctly get data as ArrayBuffer
            });
            const audioBuffer = Buffer.from(audioResponse.data); // Convert ArrayBuffer to Node.js Buffer
            const mimeType = message.audio.mime_type || 'audio/ogg; codecs=opus'; // Default MIME type

            // 3. Transcribe with Gemini
            console.log('Sending audio buffer to Gemini for transcription...');
            const audioFilePart = {
                inlineData: {
                    data: audioBuffer.toString("base64"),
                    mimeType: mimeType,
                },
            };

            const result = await model.generateContent({
                contents: [{ role: "user", parts: [audioFilePart, { text: "Please transcribe this audio file accurately." }] }],
                generationConfig,
                safetySettings,
            });

            if (!result.response || typeof result.response.text !== 'function') {
                console.error('Gemini response is not in the expected format:', JSON.stringify(result, null, 2));
                await sendSplitMessage(from, "Sorry, I received an unexpected response from the transcription service.");
                return;
            }

            const transcribedText = result.response.text();
            if (!transcribedText || transcribedText.trim() === "") {
                console.log('Gemini transcription is empty or contains only whitespace.');
                await sendSplitMessage(from, "The audio seems to be silent or could not be transcribed into meaningful text.");
                return;
            }
            console.log('Gemini Transcription:', transcribedText);

            // 4. Send Transcribed Text back to WhatsApp
            await sendSplitMessage(from, `Transcription: ${transcribedText}`);

        } else if (message.type === 'text') {
            console.log(`Processing text message from ${from}: ${message.text.body}`);
            await sendSplitMessage(from, `You said: ${message.text.body}`);
        } else {
            console.log(`Received unhandled message type: ${message.type} from ${from}`);
            // Optionally send a message back if desired for unhandled types
            // await sendSplitMessage(from, "I can currently only process text and audio messages.");
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`Error processing message from ${from}:`, errorMessage, error.stack ? error.stack : '');
        try {
            // Attempt to notify the user of a general error
            await sendSplitMessage(from, "Sorry, I encountered an internal error while processing your message. Please try again later.");
        } catch (sendError) {
            console.error(`CRITICAL: Failed to send error notification message to ${from}:`, sendError.message);
        }
    }
}

// --- Handle Incoming WhatsApp Messages ---
app.post('/webhook', (req, res) => { // Removed 'async' as we send response before async processing
    const body = req.body;
    console.log('Incoming webhook POST request:', JSON.stringify(body, null, 2));

    // Basic validation of the webhook payload
    if (body.object === 'whatsapp_business_account' &&
        body.entry && body.entry[0] &&
        body.entry[0].changes && body.entry[0].changes[0] &&
        body.entry[0].changes[0].value &&
        body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {

        // Acknowledge the webhook immediately to prevent retries from WhatsApp
        res.sendStatus(200);

        // Process the message asynchronously
        // Pass the relevant part of the body to the processing function
        processWhatsAppMessage(body).catch(err => {
            // This catch is a safety net for unhandled promise rejections from processWhatsAppMessage
            console.error("Unhandled error in detached processWhatsAppMessage:", err.message, err.stack ? err.stack : '');
            // At this point, we've already sent 200 OK. Logging is the primary action.
            // We could try to extract 'from' if the error occurs very early in processWhatsAppMessage,
            // but it's generally better to handle errors within that function.
        });

    } else {
        // If the payload structure is not what we expect for a message
        console.warn('Warn: Webhook received, but not a valid WhatsApp message event or malformed payload.');
        res.sendStatus(404); // Not Found or Bad Request could be alternatives
    }
});

// --- Function to Send WhatsApp Message ---
async function sendWhatsAppMessage(to, text) {
    console.log(`Attempting to send message to ${to}: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}" (Length: ${text.length})`);
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text },
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`Message sent successfully to ${to}.`);
    } catch (error) {
        const errorData = error.response ? error.response.data : null;
        console.error(`Error sending WhatsApp message to ${to}:`, error.message, errorData ? JSON.stringify(errorData) : '');
        throw error; // Re-throw the error so the caller (sendSplitMessage) can handle it
    }
}

// A simple helper function for creating a delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handles sending a message of any length by splitting it into chunks if it exceeds the WhatsApp API limit.
 * Reserves space for the "(x/y)" prefix.
 *
 * @param {string} to - The recipient's phone number.
 * @param {string} longText - The full text message to send.
 * @param {number} delayBetweenMessages - Milliseconds to wait between sending each part.
 */
async function sendSplitMessage(to, longText, delayBetweenMessages = 1500) {
    const MAX_LENGTH = 4096; // WhatsApp character limit for a single message
    const PREFIX_RESERVATION = 20; // Max estimated length for "(part/total) ", e.g., "(100/120) "
    const CHUNK_SIZE = MAX_LENGTH - PREFIX_RESERVATION;

    if (!longText || typeof longText !== 'string' || longText.trim() === "") {
        console.warn(`Attempted to send empty or invalid message to ${to}. Aborting.`);
        return;
    }

    // If the message is short enough to be sent without a prefix, send it directly.
    if (longText.length <= MAX_LENGTH) {
        await sendWhatsAppMessage(to, longText);
        return;
    }

    // --- Splitting Logic ---
    const chunks = [];
    for (let i = 0; i < longText.length; i += CHUNK_SIZE) {
        chunks.push(longText.substring(i, i + CHUNK_SIZE));
    }

    console.log(`Message to ${to} is too long (${longText.length} chars). Splitting into ${chunks.length} parts.`);

    // --- Sending Loop ---
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Construct the message part with a prefix, e.g., "(1/3) Hello..."
        const messagePart = `(${i + 1}/${chunks.length}) ${chunk}`;

        // Final check to ensure the constructed part (with prefix) isn't over the absolute limit
        // This should rarely, if ever, be an issue with proper CHUNK_SIZE and PREFIX_RESERVATION.
        if (messagePart.length > MAX_LENGTH) {
            console.error(`CRITICAL: Constructed message part for ${to} is too long (${messagePart.length} chars) even after prefixing. This indicates an issue with CHUNK_SIZE or PREFIX_RESERVATION. Skipping this part.`);
            // Send a truncated version or an error message for this part? For now, skip.
            // This part should be small enough to send without prefix if it was just the chunk.
            // Consider sending just the chunk if this happens, or a specific error.
            // For safety, we could try to send a truncated version of messagePart
            await sendWhatsAppMessage(to, messagePart.substring(0, MAX_LENGTH - 3) + "..."); // Truncate
            continue; // Move to the next chunk
        }

        try {
            await sendWhatsAppMessage(to, messagePart);
            // Wait between messages to help maintain order and avoid rate limits
            if (i < chunks.length - 1) {
                await delay(delayBetweenMessages);
            }
        } catch (error) {
            // Error is already logged by sendWhatsAppMessage
            console.error(`Failed to send part ${i + 1}/${chunks.length} of the message to ${to}. Aborting remaining parts for this message.`);
            // Optionally, send a message to the user indicating partial failure if it's the first part.
            if (i === 0) {
                 try {
                     await sendWhatsAppMessage(to, "Sorry, I encountered an issue while sending your multi-part message and couldn't send all of it.");
                 } catch (e) { /* ignore */ }
            }
            return; // Stop sending the rest of the message parts for this longText
        }
    }
    console.log(`All ${chunks.length} parts of the long message have been sent to ${to}.`);
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Make sure this server is publicly accessible for WhatsApp Webhooks.');
    console.log('If running locally, consider using a tunneling service like ngrok: ngrok http ' + PORT);
    console.log('Ensure your WHATSAPP_VERIFY_TOKEN in variables.env matches the one in your Facebook App dashboard.');
});